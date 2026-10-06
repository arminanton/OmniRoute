"""Exact root-private shared profile run/state directories; no arbitrary paths."""
import os
import stat
from pathlib import Path
from .controller import Refused
from .sharedApp import validate


def private_directory(path, *, mode=0o700, owner=0):
    path=Path(path)
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for index,name in enumerate(path.parts[1:]):
            last=index==len(path.parts[1:])-1
            created=False
            try:nxt=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            except FileNotFoundError:
                try:
                    os.mkdir(name,mode if last else 0o700,dir_fd=fd);created=True
                except FileExistsError:pass
                os.fsync(fd)
                nxt=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            if created and last:
                os.fchmod(nxt,mode)
                os.fchown(nxt,owner,owner)
            info=os.fstat(nxt)
            if info.st_uid!=(owner if last else 0) or not stat.S_ISDIR(info.st_mode)or info.st_mode&0o022 or(last and stat.S_IMODE(info.st_mode)!=mode):
                os.close(nxt);raise Refused('unsafe private runtime directory')
            os.close(fd);fd=nxt
    finally:os.close(fd)


def provision(layout):
    # Called only for the already-validated explicit root-installed schema2.
    # Public immutable assets need traversal; private subtrees remain0700.
    private_directory('/var/lib/omni-local-next',mode=0o711)
    for path in ('/run/omni-local-next','/run/omni-local-next/canary','/run/omni-local-next/generations',
                 '/run/omni-local-next/maintenance','/var/lib/omni-local-next/deployments',
                 '/var/lib/omni-local-next/deployments/canary'):
        private_directory(path)
    for record in layout['generations']:
        g=validate(record['generation']);private_directory('/run/omni-local-next/generations/'+g['generation'])
    m=validate(layout['maintenance']['generation'],maintenance=True)
    private_directory('/run/omni-local-next/maintenance/'+m['generation'])

    # Root-private config/CIDs stay inaccessible to workers. Only fixed temp
    # children are worker-owned; their root-owned parent permits traversal.
    private_directory('/run/omni-canary-worker',mode=0o711)
    for name in ('body','proxy','fastcgi','uwsgi','scgi'):
        private_directory('/run/omni-canary-worker/'+name,owner=65534)
