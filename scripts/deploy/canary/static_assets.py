"""Root-owned immutable union of reviewed .next/static artifacts; no automatic GC.

Only public build assets enter this store. Existing snapshots remain usable after
an app CID is retired. Root installation/approval is the host adapter's job.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import uuid
from .controller import Refused

OWNER_UID = 0
SCHEMA = "omni-static-assets/v1"
MAX_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024


def _path(value):
    path = Path(value)
    if not path.is_absolute() or any(part in (".", "..") for part in path.parts):
        raise Refused("asset path must be absolute and normalized")
    return path


def _directory(path, *, public=False):
    """Open every component without following symlinks, including ancestors."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in _path(path).parts[1:]:
            nxt = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
            if public:
                info = os.fstat(fd)
                sticky_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
                if (info.st_uid not in (0, OWNER_UID) or not info.st_mode & 0o001 or
                        (info.st_mode & 0o022 and not sticky_root)):
                    raise Refused("asset serving ancestry is not protected/publicly traversable")
        return fd
    except (OSError, Refused):
        os.close(fd)
        raise Refused("unsafe or missing asset directory") from None


def _contents(path, *, immutable=False):
    result = {}
    total = 0
    def walk(fd, prefix, depth):
        nonlocal total
        if depth > 32:
            raise Refused("asset directory depth exceeded")
        info = os.fstat(fd)
        if immutable and (info.st_uid != OWNER_UID or stat.S_IMODE(info.st_mode) != 0o555):
            raise Refused("asset directory is not owner-immutable")
        for name in sorted(os.listdir(fd)):
            if name in (".", "..") or any(ord(char) < 32 or ord(char) == 127 for char in name):
                raise Refused("unsafe asset name")
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            relative = prefix + name
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    walk(child, relative + "/", depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    actual = os.fstat(source)
                    if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                        raise Refused("asset changed during inspection")
                    if immutable and (actual.st_uid != OWNER_UID or stat.S_IMODE(actual.st_mode) != 0o444):
                        raise Refused("asset file is not owner-immutable")
                    if actual.st_size > MAX_FILE_BYTES:
                        raise Refused("asset exceeds file size bound")
                    with os.fdopen(source, "rb", closefd=False) as stream:
                        data = stream.read(MAX_FILE_BYTES + 1)
                    if len(data) != actual.st_size:
                        raise Refused("asset size changed or exceeds bound")
                    total += len(data)
                    if total > MAX_BYTES:
                        raise Refused("asset store size bound exceeded")
                    result[relative] = data
                finally:
                    os.close(source)
            else:
                raise Refused("assets cannot contain symlinks, hardlinks or special files")
    fd = _directory(path)
    try:
        walk(fd, "", 0)
    finally:
        os.close(fd)
    return result


def _manifest(contents):
    return {"schema": SCHEMA, "assets": {name: {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
            for name, data in sorted(contents.items())}}


def _encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def verify_asset_snapshot(snapshot):
    snapshot = _path(snapshot)
    if not re.fullmatch(r"[a-f0-9]{64}", snapshot.name):
        raise Refused("asset snapshot name must bind its manifest")
    contents = _contents(snapshot, immutable=True)
    raw = contents.pop(".manifest.json", None)
    if raw is None or any(not name.startswith("files/") for name in contents):
        raise Refused("asset snapshot contains unreviewed entries")
    assets = {name[6:]: value for name, value in contents.items()}
    expected = _encode(_manifest(assets))
    if raw != expected or hashlib.sha256(raw).hexdigest() != snapshot.name:
        raise Refused("asset snapshot content/manifest mismatch")
    return {"schema": SCHEMA, "digest": snapshot.name, "path": str(snapshot),
            "fileCount": len(assets), "totalBytes": sum(map(len, assets.values()))}


def merge_static_assets(old_static, new_static, store_root, *, retained_snapshot=None):
    if os.geteuid() != OWNER_UID:
        raise Refused("asset installation requires its fixed root owner")
    sources = [_path(old_static), _path(new_static)]
    if any(path.parts[-2:] != (".next", "static") for path in sources):
        raise Refused("only reviewed .next/static directories may be imported")
    root = _path(store_root)
    parent = _directory(root.parent)
    created = False
    try:
        try:
            os.mkdir(root.name, 0o755, dir_fd=parent)
            created = True
        except FileExistsError:
            pass
    finally:
        os.close(parent)
    root_fd = _directory(root)
    if created:
        os.fchmod(root_fd, 0o755)
    stage = None
    lock = None
    try:
        info = os.fstat(root_fd)
        if info.st_uid != OWNER_UID or stat.S_IMODE(info.st_mode) != 0o755:
            raise Refused("asset store root ownership/mode differs")
        lock = os.open(".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER_UID or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise Refused("unsafe asset store lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        contents = {}
        # Carry every published snapshot forward: an older browser page may still
        # need its chunks after more than one app generation has been retired.
        snapshots = []
        for name in os.listdir(root_fd):
            if name == ".lock":
                continue
            if re.fullmatch(r"\.stage-[a-f0-9]{32}", name):
                info = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != OWNER_UID or info.st_mode & 0o022:
                    raise Refused("unsafe unpublished asset stage")
                continue
            if not re.fullmatch(r"[a-f0-9]{64}", name):
                raise Refused("unrecognized asset store entry")
            snapshots.append(root / name)
        if retained_snapshot is not None:
            retained = _path(retained_snapshot)
            if retained.parent != root or retained not in snapshots:
                raise Refused("retained snapshot must belong to this store")
        for retained in snapshots:
            verify_asset_snapshot(retained)
            for name, data in _contents(retained / "files", immutable=True).items():
                if name in contents and contents[name] != data:
                    raise Refused("retained asset URL content collision")
                contents[name] = data
        for source in sources:
            for name, data in _contents(source).items():
                if name in contents and contents[name] != data:
                    raise Refused("same asset URL has different content hashes")
                contents[name] = data
        if sum(map(len, contents.values())) > MAX_BYTES:
            raise Refused("retained union exceeds asset store bound")
        for name in contents:
            if any(str(parent) in contents for parent in Path(name).parents if str(parent) != "."):
                raise Refused("asset file/directory path collision")
        raw = _encode(_manifest(contents))
        if sum(map(len, contents.values())) + len(raw) > MAX_BYTES:
            raise Refused("sealed asset snapshot exceeds store bound")
        digest = hashlib.sha256(raw).hexdigest()
        snapshot = root / digest
        if snapshot.exists():
            return verify_asset_snapshot(snapshot)
        stage = root / (".stage-" + uuid.uuid4().hex)
        os.mkdir(stage.name, 0o700, dir_fd=root_fd)
        files = stage / "files"
        files.mkdir(mode=0o700)
        for name, data in sorted(contents.items()):
            target = files / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            target.chmod(0o444)
        with (stage / ".manifest.json").open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        (stage / ".manifest.json").chmod(0o444)
        for directory, _, _ in os.walk(stage, topdown=False):
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            os.fchmod(fd, 0o555)
            os.fsync(fd)
            os.close(fd)
        os.rename(stage.name, digest, src_dir_fd=root_fd, dst_dir_fd=root_fd)
        stage = None
        os.fsync(root_fd)
        return verify_asset_snapshot(snapshot)
    finally:
        if stage is not None:
            for directory, _, _ in os.walk(stage):
                os.chmod(directory, 0o700)
            shutil.rmtree(stage)
        if lock is not None:
            os.close(lock)
        os.close(root_fd)


def nginx_location(snapshot):
    verify_asset_snapshot(snapshot)
    fd = _directory(_path(snapshot) / "files", public=True)
    os.close(fd)
    directory = str(_path(snapshot) / "files")
    if not re.fullmatch(r"/[A-Za-z0-9._/-]+", directory):
        raise Refused("asset path cannot be safely rendered in nginx")
    return f'''    location ^~ /_next/static/ {{
      alias {directory}/;
      disable_symlinks on;
      autoindex off;
      limit_except GET HEAD {{ deny all; }}
      default_type application/octet-stream;
      types {{ application/javascript js mjs; text/css css; application/json json map;
        application/wasm wasm; font/woff woff; font/woff2 woff2; font/ttf ttf;
        font/otf otf; image/svg+xml svg; image/png png; image/jpeg jpg jpeg;
        image/webp webp; image/avif avif; image/gif gif; image/x-icon ico; }}
      add_header Cache-Control "public, max-age=31536000, immutable" always;
      add_header X-Content-Type-Options nosniff always;
    }}
'''
