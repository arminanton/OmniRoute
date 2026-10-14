/**
 * Realistic software engineering scenarios for multi-turn benchmark testing.
 * 100 distinct programming projects/problems across 10 major technical domains.
 * Each scenario maintains subject continuity between Turn 1 and Turn 2.
 */

export const DEVELOPER_SCENARIOS = [
  // 1. Rust (0-9)
  {
    domain: "rust",
    topic: "Lock-Free SPSC Queue",
    turn1: "In Rust, I need a fixed-size Single-Producer Single-Consumer (SPSC) ring buffer using atomic pointers (`AtomicUsize`). Could you write a minimal, idiomatic struct definition with `push` and `pop` methods that avoid heap allocation after initialization?",
    turn2: "Thanks for this struct. Now, how should we handle cache line false sharing between the head and tail atomic indices using `repr(align(64))` or crossbeam-utils cache-padded primitives?"
  },
  {
    domain: "rust",
    topic: "Zero-Copy Parsing with Nom",
    turn1: "I am building a binary protocol parser in Rust using the `nom` crate. Can you show a parser function that reads a 4-byte big-endian magic number, a 2-byte payload length, and returns the payload slice without copying?",
    turn2: "Great. Can you show how to wrap that parser in an iterator or streaming frame decoder so we can handle partial buffer inputs from a TCP socket without dropping state?"
  },
  {
    domain: "rust",
    topic: "Async Stream Processing with Tokio",
    turn1: "Can you provide a concise Tokio example in Rust that reads lines from an asynchronous file stream, batches them into chunks of 100 items (or flushes every 500ms), and sends the batches over an `mpsc` channel?",
    turn2: "How would we update this implementation to support graceful cancellation via `tokio_util::sync::CancellationToken` so that any buffered lines in-flight are flushed before the task exits?"
  },
  {
    domain: "rust",
    topic: "Custom Allocator for Arena Allocation",
    turn1: "In Rust, when building an AST for a compiler, arena allocation is often used. How can we use the `bumpalo` crate to allocate AST expression nodes in a local arena and traverse them efficiently?",
    turn2: "Can you demonstrate how to reset or clear the arena between compiler passes, and explain what happens to the references held by parent structures?"
  },
  {
    domain: "rust",
    topic: "SIMD Acceleration with std::simd",
    turn1: "Could you show a simple example using Rust's portable SIMD (`std::simd`) to compute the dot product of two `f32` slices with AVX2 or NEON acceleration?",
    turn2: "What is the idiomatic way to handle the remainder loop when the input slice length is not an exact multiple of the SIMD lane count?"
  },
  {
    domain: "rust",
    topic: "Procedural Macro for Struct Serialization",
    turn1: "How do I write a minimal derive procedural macro in Rust using `syn` and `quote` that generates a custom `to_kv_pairs()` method for named structs?",
    turn2: "How can we extend this derive macro to inspect field attributes like `#[kv(skip)]` and exclude those marked fields from the generated code?"
  },
  {
    domain: "rust",
    topic: "Foreign Function Interface (FFI) with C",
    turn1: "I need to expose a Rust function `process_buffer(ptr: *const u8, len: usize) -> i32` to C. How should the `extern \"C\"` signature and panic boundary (`catch_unwind`) be structured safely?",
    turn2: "How should we handle memory ownership if the Rust function needs to allocate and return a newly created C-compatible null-terminated string (`CString`) back to the C caller?"
  },
  {
    domain: "rust",
    topic: "High-Performance LRU Cache",
    turn1: "How would you implement an LRU cache in Rust that uses a `HashMap` paired with an intrusive doubly-linked list or indices into a vector to achieve O(1) get and put?",
    turn2: "Can we wrap this LRU cache with `parking_lot::RwLock` or a sharded mutex pattern to allow concurrent read access across multiple worker threads?"
  },
  {
    domain: "rust",
    topic: "Typestate Pattern in Protocol Design",
    turn1: "Can you demonstrate the typestate pattern in Rust to enforce at compile time that an HTTP request builder must set a URL and a Method before `send()` can be called?",
    turn2: "How can we extend the typestate builder to support optional authentication headers while preserving the compile-time guarantee on mandatory fields?"
  },
  {
    domain: "rust",
    topic: "Linux eBPF with Aya",
    turn1: "In Rust, using the `aya` framework, what does a minimal eBPF XDP program look like to inspect incoming IPv4 packets and drop traffic matching a specific destination port?",
    turn2: "How does user-space code read statistics or map entries exported by this XDP eBPF program using Aya's user-space crate?"
  },

  // 2. Go (10-19)
  {
    domain: "go",
    topic: "Bounded Worker Pool with Context",
    turn1: "In Go, write an idiomatic worker pool that processes jobs from a channel using a fixed number of goroutines (e.g. 10 workers), handles `context.Context` cancellation, and waits for active jobs to finish with `sync.WaitGroup`.",
    turn2: "How can we enhance this worker pool to collect errors from failing jobs into a thread-safe error collector, and abort remaining jobs if more than 3 workers fail?"
  },
  {
    domain: "go",
    topic: "High-Throughput In-Memory Rate Limiter",
    turn1: "How can I implement a token bucket rate limiter in Go that allows up to `rate` tokens per second with a given burst capacity, using `sync.Mutex` and monotonic timestamps (`time.Now()`)?",
    turn2: "How can we benchmark this rate limiter with `testing.B` and reduce mutex contention under high concurrent load across dozens of goroutines?"
  },
  {
    domain: "go",
    topic: "Graceful HTTP Server Shutdown",
    turn1: "Can you provide an idiomatic Go `main()` function that starts an `http.Server` and listens for `SIGINT` and `SIGTERM` signals to perform a graceful shutdown within a 10-second timeout?",
    turn2: "How should we coordinate the HTTP server shutdown with closing active database connection pools and draining background background tasks?"
  },
  {
    domain: "go",
    topic: "Custom Generics Cache with Expiry",
    turn1: "In Go 1.20+, write a generic in-memory cache `Cache[K comparable, V any]` with `Set(key K, value V, ttl time.Duration)` and `Get(key K) (V, bool)` methods protected by `sync.RWMutex`.",
    turn2: "How should we implement an efficient background cleaner goroutine that evicts expired keys periodically without locking the entire cache for extended durations?"
  },
  {
    domain: "go",
    topic: "Streaming gRPC Interceptor",
    turn1: "How do you write a unary and stream server interceptor in Go for gRPC that logs the method name, caller peer IP, and execution latency for each RPC call?",
    turn2: "Can you show how to inject OpenTelemetry distributed tracing context into the Go `context.Context` within that interceptor?"
  },
  {
    domain: "go",
    topic: "Zero-Allocation Buffer Pooling with sync.Pool",
    turn1: "How should `sync.Pool` be used in Go to reuse `bytes.Buffer` instances in an HTTP middleware to avoid heap allocations on every incoming request?",
    turn2: "What pitfalls exist with `sync.Pool` regarding buffer growth (e.g., buffers holding onto megabytes of memory), and how do we enforce a max capacity reset before returning to the pool?"
  },
  {
    domain: "go",
    topic: "Concurrent Hash Ring for Distributed Sharding",
    turn1: "Implement a consistent hashing ring in Go with virtual nodes using `sort.Search` to map string keys to a cluster of cache node addresses.",
    turn2: "How do we handle dynamic node addition and removal on the ring with minimum key redistribution, and how do we ensure concurrent read/write safety?"
  },
  {
    domain: "go",
    topic: "Low-Latency Event Dispatcher with Channels",
    turn1: "Can you write a pub-sub fan-out event bus in Go where multiple subscribers can register for specific event topics and receive messages asynchronously over buffered channels?",
    turn2: "How should slow subscribers be handled so that a single sluggish consumer does not block the publisher or exhaust memory queues (e.g., drop policies vs timeouts)?"
  },
  {
    domain: "go",
    topic: "SQL Connection Pool Tuning",
    turn1: "In Go using `database/sql` with PostgreSQL (pgx), what are the best practices for configuring `SetMaxOpenConns`, `SetMaxIdleConns`, and `SetConnMaxLifetime` for a high-concurrency microservice?",
    turn2: "How can we expose these database connection pool metrics (in-use connections, wait duration, idle count) to Prometheus using `db.Stats()`?"
  },
  {
    domain: "go",
    topic: "Structured Logging with slog",
    turn1: "How do you configure Go's `log/slog` package with a JSON handler that automatically appends request ID, user ID, and environment tags from `context.Context`?",
    turn2: "How can we create a custom `slog.Handler` wrapper that redacts sensitive keys (like authorization tokens or passwords) from log records?"
  },

  // 3. TypeScript & Node.js (20-34)
  {
    domain: "typescript",
    topic: "Type-Safe Event Emitter",
    turn1: "In TypeScript, create a strongly-typed `TypedEventEmitter<Events>` class where `Events` is an interface mapping event names to their tuple argument types, guaranteeing full type-safety for `emit` and `on`.",
    turn2: "How can we extend this to support async listeners with `emitParallel` that returns a `Promise.all` of all registered handler results?"
  },
  {
    domain: "typescript",
    topic: "Recursive JSON Validator Type",
    turn1: "Can you write TypeScript conditional and mapped types that validate whether an arbitrary object type matches a JSON-serializable structure (disallowing functions, symbols, and undefined values)?",
    turn2: "How can we extract the exact path of any invalid property into a compile-time type error or descriptive string literal?"
  },
  {
    domain: "typescript",
    topic: "Async Pipeline and Middleware Engine",
    turn1: "How do you implement an async middleware onion pipeline in TypeScript (similar to Koa's `compose`) where middlewares take `(context: T, next: () => Promise<void>) => Promise<void>`?",
    turn2: "How can we add execution timeout guards and error boundary catching so that if one middleware fails or hangs, downstream middlewares receive a proper error status?"
  },
  {
    domain: "typescript",
    topic: "Batching DataLoader Pattern",
    turn1: "Implement a lightweight TypeScript `DataLoader` class that batches multiple single-item `load(id: string): Promise<T>` calls within the same event-loop tick using `queueMicrotask`.",
    turn2: "How do we add per-tick memoization caching to this DataLoader and provide a `clear(id)` method to invalidate stale entries?"
  },
  {
    domain: "typescript",
    topic: "Node.js High-Throughput Stream Backpressure",
    turn1: "In Node.js, write a custom `Transform` stream in TypeScript that processes JSON lines from a readable stream, hashes a field, and properly honors backpressure when `push()` returns false.",
    turn2: "How do you pipe this transform stream to an HTTP response using `stream.promises.pipeline` with proper error cleanup and abort signal handling?"
  },
  {
    domain: "typescript",
    topic: "Distributed Lock with Redis and Redlock",
    turn1: "How do you implement an async distributed lock utility in TypeScript with Redis using single-instance `SET key uuid NX PX 10000` and release via Lua script?",
    turn2: "Can you show how to add an automatic lock renewal heartbeat (watchdog timer) that extends the TTL while the protected async operation is still executing?"
  },
  {
    domain: "typescript",
    topic: "Typed State Machine with XState Concept",
    turn1: "How can we build a lightweight, strictly-typed finite state machine (FSM) in TypeScript using discriminated unions that forbids invalid state transitions at compile time?",
    turn2: "How can we attach async transition side-effects (entry/exit actions) while keeping transition records serializable to JSON?"
  },
  {
    domain: "typescript",
    topic: "Undici Custom Connection Pool Tuning",
    turn1: "When making 100+ parallel outbound HTTP/2 or HTTP/1.1 calls in Node.js using `undici.Agent`, what are the key options (`connections`, `pipelining`, `headersTimeout`) to prevent socket exhaustion?",
    turn2: "How do we capture connection pool telemetry (active sockets, queued requests, idle sockets) to debug connection starvation under heavy load?"
  },
  {
    domain: "typescript",
    topic: "Server-Sent Events (SSE) Multiplexer",
    turn1: "How do you build a clean Server-Sent Events (SSE) handler in Node.js (with standard `ReadableStream` or HTTP response) that formats event frames (`event:`, `data:`, `id:`) correctly?",
    turn2: "How can we handle client disconnections gracefully by wiring `request.signal.addEventListener('abort', ...)` and cleaning up all active channel subscriptions?"
  },
  {
    domain: "typescript",
    topic: "Compile-Time Deep Immutability Utility",
    turn1: "Write a TypeScript utility type `DeepReadonly<T>` that recursively marks all properties, nested objects, arrays, and maps as `readonly` while preserving function signatures and primitive types.",
    turn2: "How do we write a complementary `DeepWritable<T>` type and test both against complex nested generic interfaces?"
  },
  {
    domain: "typescript",
    topic: "Dynamic Plugin System with ESM Imports",
    turn1: "How can a Node.js CLI dynamically load external plugin modules from disk using `import()` in TypeScript, validating that each plugin exports a compliant `PluginDefinition` interface?",
    turn2: "How do we sandbox or restrict plugin execution to prevent malicious modules from tampering with global prototypes or environment variables?"
  },
  {
    domain: "typescript",
    topic: "Binary Wire Protocol Serializer",
    turn1: "Write a TypeScript utility using `ArrayBuffer` and `DataView` to serialize and deserialize a binary telemetry packet containing a timestamp (uint64), sensor ID (uint16), and reading (float32).",
    turn2: "How can we handle endianness explicitly and optimize serialization speed when packing an array of 10,000 readings into a single contiguous buffer?"
  },
  {
    domain: "typescript",
    topic: "Zero-Dependency CLI Flag Parser",
    turn1: "Write a clean TypeScript function that parses `process.argv.slice(2)` into a structured object supporting `--flag`, `--key=value`, `-k value`, and positional arguments without third-party libraries.",
    turn2: "How can we add support for type coercion (boolean, integer, string) and automatic `--help` text generation based on a schema declaration?"
  },
  {
    domain: "typescript",
    topic: "Worker Threads Compute Offload",
    turn1: "In Node.js, how do you offload CPU-intensive cryptography or image hashing tasks from the main event loop to a pool of `worker_threads` using `MessageChannel`?",
    turn2: "How can we transfer memory efficiently between the main thread and workers using `Transferable` `ArrayBuffer` objects without copying bytes?"
  },
  {
    domain: "typescript",
    topic: "React Server Components Streaming Architecture",
    turn1: "Explain how React Server Components (RSC) serialize server component trees over HTTP using wire format chunking, and how Suspense boundaries stream HTML to the browser.",
    turn2: "What strategies should be employed to prevent waterfall requests when multiple nested server components fetch data independently?"
  },

  // 4. Python (35-49)
  {
    domain: "python",
    topic: "Asyncio High-Throughput Worker Pipeline",
    turn1: "In Python, build an `asyncio` processing pipeline with a bounded `asyncio.Queue` where producer coroutines fetch URLs and a pool of 5 consumer coroutines parse responses concurrently.",
    turn2: "How do we implement a graceful shutdown signal using `queue.join()`, cancelling consumer tasks and ensuring all finished items are recorded to disk?"
  },
  {
    domain: "python",
    topic: "Memory-Efficient Large CSV Processing",
    turn1: "How can we process a 20GB CSV file in Python without exceeding 100MB of RAM using generator pipelines, the standard `csv` module, and `itertools`?",
    turn2: "How can we parallelize the row processing phase across multiple CPU cores using `multiprocessing.Pool` or `concurrent.futures.ProcessPoolExecutor` while maintaining streaming input?"
  },
  {
    domain: "python",
    topic: "FastAPI Dependency Injection and Lifespan",
    turn1: "In FastAPI with Python 3.11+, how do you set up an application lifespan manager (`@asynccontextmanager`) that initializes an async database pool and Redis client, and injects them via `Depends`?",
    turn2: "How should we write unit and integration tests using `pytest-asyncio` and `httpx.AsyncClient` that override these dependencies with in-memory test doubles?"
  },
  {
    domain: "python",
    topic: "Pydantic V2 Custom Validators and Performance",
    turn1: "In Pydantic v2, write a model for validating nested e-commerce order payloads with custom `@field_validator` and `@model_validator` methods that ensure total prices match item quantities.",
    turn2: "How do we optimize Pydantic deserialization performance when parsing thousands of incoming JSON payloads per second using `TypeAdapter` and Rust-backed core validation?"
  },
  {
    domain: "python",
    topic: "Custom Python Context Manager with Generator",
    turn1: "How do you write a robust Python context manager using `@contextlib.contextmanager` that temporarily redirects stdout/stderr and restores them safely even if an unhandled exception occurs?",
    turn2: "How can we make this context manager asynchronous (`@contextlib.asynccontextmanager`) to acquire and release an async distributed lock with retry logic?"
  },
  {
    domain: "python",
    topic: "Metaclass and Class Decorator Patterns",
    turn1: "Explain when to choose a class decorator versus a custom metaclass in Python. Provide a clean example of registering API handler classes automatically in a global registry using a decorator.",
    turn2: "How can we enforce method signature compliance on registered classes using `inspect.signature` during class registration time?"
  },
  {
    domain: "python",
    topic: "Async SQLAlchemy 2.0 with PostgreSQL",
    turn1: "Show how to set up an async SQLAlchemy 2.0 session factory with PostgreSQL (`asyncpg`) and write an async repository function that executes an eager join using `selectinload`.",
    turn2: "How should transaction rollback and connection recovery be handled during transient PostgreSQL connection drops or deadlock exceptions?"
  },
  {
    domain: "python",
    topic: "Python GIL and Multithreading vs Multiprocessing",
    turn1: "Explain how Python 3.13 free-threaded (no-GIL) build impacts CPU-bound multithreaded performance compared to traditional CPython. Provide an illustrative benchmark structure.",
    turn2: "What concurrency bugs (like data races in pure Python objects) become possible under free-threaded Python that the GIL previously masked, and how do we guard against them?"
  },
  {
    domain: "python",
    topic: "Cython / C-Extension Acceleration",
    turn1: "How can we write a minimal C-extension or Cython module in Python to compute the Levenshtein distance between two strings with native C execution speed?",
    turn2: "How do you package this compiled extension with `pyproject.toml` and `setuptools` so it compiles seamlessly during `pip install` across Linux and macOS?"
  },
  {
    domain: "python",
    topic: "Structured Concurrency with TaskGroup",
    turn1: "Using Python 3.11's `asyncio.TaskGroup`, demonstrate how to launch multiple background network calls concurrently, ensuring that if any single task fails, all sibling tasks are cancelled promptly.",
    turn2: "How do we inspect and unpack the resulting `ExceptionGroup` to handle specific exceptions while letting critical errors bubble up?"
  },
  {
    domain: "python",
    topic: "Dynamic Dispatch and Single Dispatch Generic Functions",
    turn1: "How do you use `functools.singledispatch` in Python to format different data structures (dicts, lists, custom domain models) into serialized XML strings?",
    turn2: "How can we extend this to support method dispatch inside classes (`singledispatchmethod`) and handle inheritance hierarchies cleanly?"
  },
  {
    domain: "python",
    topic: "Memory Leak Debugging with tracemalloc",
    turn1: "How do you use Python's built-in `tracemalloc` and `gc` modules to take heap snapshots and identify the exact lines of code leaking memory in a long-running service?",
    turn2: "How can we automate periodic memory leak detection by comparing top memory allocation diffs (`snapshot2.compare_to(snapshot1, 'lineno')`) in a background diagnostic thread?"
  },
  {
    domain: "python",
    topic: "Custom Pytest Plugins and Fixture Scopes",
    turn1: "How do you create a custom `pytest` plugin with session-scoped fixtures that spin up temporary Docker containers (using `testcontainers-python`) for test suites?",
    turn2: "How can we ensure container teardown executes reliably even when the test runner is aborted with Ctrl+C or a fatal assertion failure?"
  },
  {
    domain: "python",
    topic: "Network Protocol Mocking with Respx",
    turn1: "How do you mock outbound HTTP requests in `httpx` using `respx` during async unit testing, including simulating network timeouts and 503 service unavailable responses?",
    turn2: "How do we assert that our application code implements proper exponential backoff retry when receiving those simulated 503 responses?"
  },
  {
    domain: "python",
    topic: "Zero-Copy Data Transfer with memoryview",
    turn1: "Demonstrate how Python's `memoryview` and buffer protocol avoid copying bytes when slicing large bytearrays or transmitting data over raw BSD sockets.",
    turn2: "What are the safety restrictions when mutating a `memoryview` that has active exported references, and how do we release the buffer cleanly?"
  },

  // 5. Database & SQL Systems (50-64)
  {
    domain: "database",
    topic: "PostgreSQL Composite Index and Query Optimization",
    turn1: "I have a PostgreSQL table `user_events` with 50M rows containing `tenant_id`, `created_at`, `event_type`, and `payload` (JSONB). Write the optimal composite index for queries filtering on `tenant_id` and ordering by `created_at DESC`.",
    turn2: "If we frequently query `payload->>'status' = 'failed'`, should we add a partial index or a GIN index on the JSONB column? Please compare the write overhead and query plan differences."
  },
  {
    domain: "database",
    topic: "SQLite WAL Mode and Concurrency Tuning",
    turn1: "In SQLite, what PRAGMA settings (`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `cache_size`) are essential for running 50+ concurrent read transactions alongside a single writer thread?",
    turn2: "How do we prevent WAL file bloat under continuous high-frequency writes, and how should passive vs truncate WAL checkpoints (`wal_checkpoint(TRUNCATE)`) be scheduled?"
  },
  {
    domain: "database",
    topic: "PostgreSQL Isolation Levels and Deadlocks",
    turn1: "Explain the difference between `READ COMMITTED`, `REPEATABLE READ`, and `SERIALIZABLE` in PostgreSQL. Give a concrete example of a write skew anomaly that occurs in `REPEATABLE READ`.",
    turn2: "How should an application handle PostgreSQL serialization failure errors (SQLSTATE `40001`) with automatic retry logic without deadlocking concurrent transactions?"
  },
  {
    domain: "database",
    topic: "Redis Pub/Sub vs Streams for Event Delivery",
    turn1: "Compare Redis Pub/Sub with Redis Streams (`XADD`, `XREADGROUP`) for building a reliable event bus. What happens in Pub/Sub if a subscriber is temporarily disconnected?",
    turn2: "Can you provide the Redis commands to set up a consumer group, process pending messages, and acknowledge (`XACK`) processed stream entries?"
  },
  {
    domain: "database",
    topic: "Partitioning Large Tables in PostgreSQL",
    turn1: "How do you set up declarative range partitioning by date (`PARTITION BY RANGE (created_at)`) for a high-volume metrics table in PostgreSQL 15+?",
    turn2: "How can we automate the creation of future monthly partition tables and drop partitions older than 90 days using `pg_partman` or a scheduled cron job?"
  },
  {
    domain: "database",
    topic: "ClickHouse Real-Time Analytics Ingestion",
    turn1: "What is the recommended table engine in ClickHouse for high-throughput time-series event ingestion (`ReplacingMergeTree` vs `SummingMergeTree`), and how should the primary sorting key be chosen?",
    turn2: "Why should individual inserts be batched into chunks of 10,000+ rows in ClickHouse instead of single-row inserts, and how does the asynchronous insert buffer (`async_insert=1`) work?"
  },
  {
    domain: "database",
    topic: "Database Migration Zero-Downtime Pattern",
    turn1: "Explain the expand-contract (parallel-run) migration pattern for renaming a column in a production PostgreSQL database with 100M rows without taking the application offline.",
    turn2: "Can you show the exact migration steps (including trigger creation, dual-writing, backfill batching, and trigger removal) across consecutive application releases?"
  },
  {
    domain: "database",
    topic: "Elasticsearch / OpenSearch Mapping Optimization",
    turn1: "How do you design an OpenSearch index template for log search with dynamic template mapping that disables field analysis on keyword fields and optimizes doc values for aggregations?",
    turn2: "How does index lifecycle management (ILM) roll over active hot indices to warm/cold storage tiers based on primary shard size and age?"
  },
  {
    domain: "database",
    topic: "PostgreSQL Connection Pooling with PgBouncer",
    turn1: "What are the trade-offs between Session, Transaction, and Statement pooling modes in PgBouncer when connecting a pool of Node.js / Python application workers to PostgreSQL?",
    turn2: "Why do prepared statements (`PREPARE` / `EXECUTE`) require special consideration in transaction pooling mode, and how do modern drivers (like `pgx` or `pg`) work around this?"
  },
  {
    domain: "database",
    topic: "MongoDB Sharding and Chunk Balancer",
    turn1: "How should a shard key be selected in MongoDB to avoid hot-spotting on write-heavy collections, and what are the trade-offs of hashed versus ranged shard keys?",
    turn2: "How do you configure the chunk size and balancer window in MongoDB to prevent network and I/O congestion during peak operational hours?"
  },
  {
    domain: "database",
    topic: "Distributed Transactions with Two-Phase Commit",
    turn1: "Explain how Two-Phase Commit (2PC) works across heterogeneous databases, and why it is vulnerable to coordinator crashes during the prepare-to-commit window.",
    turn2: "How does the Saga pattern with compensating transactions provide an alternative for microservice architectures, and how do we handle compensation failures?"
  },
  {
    domain: "database",
    topic: "Cassandra Data Modeling for High Write Throughput",
    turn1: "How do you design a Cassandra CQL table for storing IoT sensor telemetry, choosing partition keys and clustering keys to prevent unbounded partition growth?",
    turn2: "What is the tombstone threshold warning in Cassandra, and how do we design queries to avoid scanning deleted rows during range scans?"
  },
  {
    domain: "database",
    topic: "DynamoDB Single-Table Design",
    turn1: "Explain the core principles of DynamoDB single-table design using generic partition keys (`PK`) and sort keys (`SK`) to satisfy multiple 1-to-many entity access patterns.",
    turn2: "How do Global Secondary Indexes (GSIs) allow query flexibility on alternative attributes, and what is the cost of sparse GSI indexing on write capacity units?"
  },
  {
    domain: "database",
    topic: "PostgreSQL Advisory Locks for Task Scheduling",
    turn1: "How do you use PostgreSQL advisory locks (`pg_try_advisory_lock` / `pg_advisory_unlock`) to coordinate single-leader cron task execution across a cluster of API containers?",
    turn2: "What is the difference between session-level and transaction-level advisory locks, and what happens if the holding connection abruptly disconnects?"
  },
  {
    domain: "database",
    topic: "Database Replica Lag and Read-Your-Own-Writes",
    turn1: "In a primary-replica database setup with asynchronous replication, how can an application guarantee read-your-own-writes consistency immediately after a user creates or updates a record?",
    turn2: "Can you show how to use replication LSN (Log Sequence Number) or write tokens stored in user session cookies to route reads to the primary until the replica catches up?"
  },

  // 6. Systems & Linux Networking (65-74)
  {
    domain: "systems",
    topic: "Linux Network Namespace and Routing Isolation",
    turn1: "How do you configure an isolated Linux network namespace (`ip netns add omni-app`) with a veth pair, connect it to a bridge on the default namespace, and enable NAT masquerading via iptables?",
    turn2: "How can we route all egress traffic from that netns through a specific wireguard/tailscale interface while preventing any traffic leakage via default routes?"
  },
  {
    domain: "systems",
    topic: "Epoll and Non-Blocking Socket I/O in C",
    turn1: "In C, show the core loop using `epoll_create1`, `epoll_ctl`, and `epoll_wait` to handle 10,000 non-blocking TCP socket connections in edge-triggered mode (`EPOLLET`).",
    turn2: "Why must non-blocking sockets in edge-triggered mode read in a loop until `EAGAIN` / `EWOULDBLOCK`, and how do we avoid starvation when one socket has massive incoming data?"
  },
  {
    domain: "systems",
    topic: "Linux TCP Keepalive and Socket Timeout Tuning",
    turn1: "What sysctl parameters (`tcp_keepalive_time`, `tcp_keepalive_intvl`, `tcp_keepalive_probes`, `tcp_fin_timeout`) should be adjusted on high-concurrency proxy gateways to clean up dead peer connections quickly?",
    turn2: "How can an application override these system defaults per-socket in Linux using `setsockopt` with `TCP_KEEPIDLE`, `TCP_KEEPINTVL`, and `TCP_KEEPCNT`?"
  },
  {
    domain: "systems",
    topic: "File Descriptor Limits and SO_REUSEPORT",
    turn1: "Explain how the `SO_REUSEPORT` socket option in Linux allows multiple independent worker processes to bind to the exact same TCP port and let the kernel load-balance incoming SYN packets.",
    turn2: "How does `SO_REUSEPORT` interact with systemd socket activation and zero-downtime rolling upgrades of backend binaries?"
  },
  {
    domain: "systems",
    topic: "Memory Mapping Large Files with mmap",
    turn1: "How do you use `mmap` in C / C++ or Rust to read and modify a 50GB file on disk without loading it into physical RAM, and what flags (`MAP_SHARED`, `PROT_READ`, `PROT_WRITE`) are required?",
    turn2: "How does `madvise` with `MADV_WILLNEED` or `MADV_SEQUENTIAL` inform the kernel page cache to optimize readahead performance for sequential traversals?"
  },
  {
    domain: "systems",
    topic: "Linux cgroups v2 and OOM Killer Mechanics",
    turn1: "In Linux cgroups v2, what is the difference between `memory.high` and `memory.max`, and how does the kernel reclaim page cache before invoking the OOM killer?",
    turn2: "How can a monitoring daemon listen for cgroup memory pressure events using `memory.pressure` (Pressure Stall Information - PSI) and poll `/proc/pressure/memory`?"
  },
  {
    domain: "systems",
    topic: "Zero-Copy Socket Transfer with splice and sendfile",
    turn1: "How do the Linux system calls `sendfile` and `splice` achieve zero-copy data transfer from a file descriptor to a network socket without copying data into user-space memory buffers?",
    turn2: "Can you provide a minimal C or Rust code example demonstrating `splice()` through an intermediate pipe to proxy traffic between two network sockets?"
  },
  {
    domain: "systems",
    topic: "Coroutines and User-Space Context Switching",
    turn1: "How do cooperative user-space coroutines (fibers) save and restore CPU registers and stack pointers during a context switch? Provide an overview using `setjmp`/`longjmp` or assembly.",
    turn2: "What happens when a cooperative coroutine executes a blocking OS system call, and how do async runtimes (like Go or Tokio) transition blocking calls to OS thread pools?"
  },
  {
    domain: "systems",
    topic: "TLS 1.3 Handshake and 0-RTT Early Data",
    turn1: "How does the TLS 1.3 handshake reduce connection latency to 1-RTT compared to TLS 1.2's 2-RTT handshake, and how are Diffie-Hellman keys exchanged in the ClientHello?",
    turn2: "What replay attack vulnerabilities exist with TLS 1.3 0-RTT Early Data (`early_data`), and why should it only be allowed for idempotent GET requests?"
  },
  {
    domain: "systems",
    topic: "CPU Cache Coherency and MESI Protocol",
    turn1: "Explain how multi-core CPUs maintain cache coherency using the MESI (Modified, Exclusive, Shared, Invalid) protocol when two cores read and write to adjacent memory addresses.",
    turn2: "How does false sharing degrade throughput in concurrent programs, and how do alignment attributes (`alignas(64)`) prevent two independently accessed variables from sharing a cache line?"
  },

  // 7. DevOps, Containers & Kubernetes (75-84)
  {
    domain: "devops",
    topic: "Docker Multi-Stage Build Optimization",
    turn1: "Show a production-grade multi-stage Dockerfile for a Node.js TypeScript application that uses separate stages for dependency caching, building, and running as a non-root user on a minimal Alpine or distroless base image.",
    turn2: "How can we use BuildKit cache mounts (`--mount=type=cache,target=/root/.npm`) to speed up CI/CD pipeline build times without bloating final image layers?"
  },
  {
    domain: "devops",
    topic: "Kubernetes Pod Lifecycle and Graceful Termination",
    turn1: "Explain the exact sequence of events when a Kubernetes Pod is deleted, from `SIGTERM` dispatch to endpoint removal from kube-proxy and Ingress controllers.",
    turn2: "Why is a `preStop` hook with a small sleep (`sleep 5`) often necessary to prevent 502 Bad Gateway errors during rolling updates in Kubernetes?"
  },
  {
    domain: "devops",
    topic: "Prometheus Metrics and Histogram Design",
    turn1: "When exposing Prometheus metrics for an API gateway, how should histogram buckets for request duration be selected to provide accurate p95 and p99 latency percentiles?",
    turn2: "Write the PromQL query to calculate the 99th percentile request latency per service over a 5-minute sliding window using `histogram_quantile`."
  },
  {
    domain: "devops",
    topic: "Terraform Infrastructure as Code Patterns",
    turn1: "In Terraform 1.5+, show how to write a reusable module for deploying an AWS ECS Fargate service with an Application Load Balancer and autoscaling target tracking policies.",
    turn2: "How do you manage remote state locking with S3 and DynamoDB, and how should sensitive outputs (like database passwords) be protected?"
  },
  {
    domain: "devops",
    topic: "NGINX Reverse Proxy Tuning for High-Volume SSE",
    turn1: "What NGINX configuration directives (`proxy_buffering off;`, `proxy_read_timeout`, `proxy_set_header Connection ''`, `proxy_http_version 1.1;`) are required to proxy long-lived Server-Sent Events (SSE) without buffer truncation or premature drops?",
    turn2: "How do we configure client rate limiting in NGINX using `limit_req_zone` with burst and nodelay while whitelisting internal healthcheck subnets?"
  },
  {
    domain: "devops",
    topic: "Kubernetes Horizontal Pod Autoscaler (HPA)",
    turn1: "How do you configure a Kubernetes HPA v2 to autoscale a deployment based on both CPU utilization and custom Prometheus metrics (e.g. `http_requests_per_second`) via the Prometheus Adapter?",
    turn2: "How do we tune the `behavior.scaleDown.stabilizationWindowSeconds` to prevent thrashing (rapid scaling up and down) during bursty traffic spikes?"
  },
  {
    domain: "devops",
    topic: "CI/CD Pipeline Security and Dependency Scanning",
    turn1: "What automated security checks should be integrated into a GitHub Actions pipeline before building container images (e.g. Trivy container scanning, SAST, secret detection)?",
    turn2: "How can we implement SLSA (Supply-chain Levels for Software Artifacts) provenance generation and container image signing using Sigstore/Cosign?"
  },
  {
    domain: "devops",
    topic: "Service Mesh Traffic Shifting and Canary Releases",
    turn1: "In Istio, write the `VirtualService` and `DestinationRule` manifests to split incoming production traffic 90/10 between v1 (stable) and v2 (canary) subsets.",
    turn2: "How can we route traffic to the canary version based on specific HTTP request headers (e.g., `x-canary: true` or user role) for internal developer testing?"
  },
  {
    domain: "devops",
    topic: "eBPF-Based Observability with Cilium",
    turn1: "Explain how Cilium uses eBPF to bypass iptables connection tracking overhead in large Kubernetes clusters, and how it handles kube-proxy service routing directly in the Linux socket layer.",
    turn2: "How does Hubble provide real-time L3/L4/L7 network policy visibility and flow metrics without requiring sidecar proxies in every pod?"
  },
  {
    domain: "devops",
    topic: "Systemd Service Hardening and Sandboxing",
    turn1: "What systemd service configuration directives (`ProtectSystem=strict`, `ProtectHome=yes`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, `CapabilityBoundingSet=`) should be applied to harden an unprivileged backend service on Linux?",
    turn2: "How do you configure dynamic user isolation with `DynamicUser=yes` and persistent directory access with `StateDirectory=`?"
  },

  // 8. Security, Auth & Identity (85-94)
  {
    domain: "security",
    topic: "OAuth 2.0 PKCE Flow for Public Clients",
    turn1: "Explain the OAuth 2.0 Authorization Code Flow with PKCE (Proof Key for Code Exchange). How do `code_verifier` and `code_challenge` prevent authorization code interception attacks on mobile and SPA apps?",
    turn2: "Can you provide a minimal TypeScript or Python code snippet to generate a cryptographically random `code_verifier` and its corresponding SHA256 base64url-encoded `code_challenge`?"
  },
  {
    domain: "security",
    topic: "JWT Verification and Asymmetric Key Rotation",
    turn1: "How should an API gateway verify incoming JWT bearer tokens using a JSON Web Key Set (JWKS) endpoint with RS256/ES256, caching public keys and respecting key IDs (`kid`)?",
    turn2: "How do we handle JWKS key rotation gracefully without rejecting valid tokens during the rollover window or allowing cache-poisoning attacks on unrecognized `kid`s?"
  },
  {
    domain: "security",
    topic: "Role-Based Access Control (RBAC) vs ABAC",
    turn1: "Compare Role-Based Access Control (RBAC) with Attribute-Based Access Control (ABAC) in multi-tenant SaaS applications. When does RBAC suffer from 'role explosion'?",
    turn2: "Show how to define a flexible authorization policy in Open Policy Agent (OPA) using Rego that grants access based on user tenant, resource ownership, and time-of-day attributes."
  },
  {
    domain: "security",
    topic: "Mutual TLS (mTLS) Certificate Lifecycle",
    turn1: "Explain how mutual TLS (mTLS) establishes bidirectional identity verification between two microservices. What certificate fields are typically inspected for authorization (SAN / CN)?",
    turn2: "How can short-lived mTLS client certificates be rotated automatically without restarting services or interrupting active persistent TCP connection pools?"
  },
  {
    domain: "security",
    topic: "CSRF and SameSite Cookie Defenses",
    turn1: "How do `SameSite=Strict`, `SameSite=Lax`, and `SameSite=None` cookie attributes mitigate Cross-Site Request Forgery (CSRF) attacks in modern web browsers?",
    turn2: "Why is a secondary defense (such as anti-CSRF tokens or custom request headers like `X-Requested-With`) still recommended for state-changing POST/PUT APIs?"
  },
  {
    domain: "security",
    topic: "Cryptographic Password Hashing with Argon2id",
    turn1: "Why is Argon2id preferred over bcrypt and PBKDF2 for password hashing, and how do memory cost, time cost, and parallelism parameters defend against GPU and ASIC brute-force attacks?",
    turn2: "Show a Python or Node.js example using Argon2id to hash passwords and verify attempts, including rehashing if the security parameter thresholds have been increased."
  },
  {
    domain: "security",
    topic: "API Key Management and Secure Hashing",
    turn1: "When issuing API keys to third-party developers, why should the raw secret key never be stored directly in the database, and how does storing a SHA-256 hash with a key prefix (`sk_live_...`) protect user credentials?",
    turn2: "How do we implement constant-time string comparison (`crypto.timingSafeEqual`) to protect API key validation against side-channel timing attacks?"
  },
  {
    domain: "security",
    topic: "Web Application Firewall (WAF) Rule Tuning",
    turn1: "How do WAF engines (like ModSecurity or AWS WAF) detect SQL injection (SQLi) and Cross-Site Scripting (XSS) patterns, and why do overly strict rules cause false positives on developer payloads?",
    turn2: "What is the recommended approach for testing and deploying WAF rule updates in non-blocking count/monitoring mode before enforcing block actions in production?"
  },
  {
    domain: "security",
    topic: "Secrets Management with HashiCorp Vault",
    turn1: "Explain how applications authenticate to HashiCorp Vault using Kubernetes service account tokens, and how Vault issues dynamic, lease-based database credentials with auto-revocation.",
    turn2: "How should an application background thread monitor lease expiration and renew the credential lease (`/sys/leases/renew`) before it expires?"
  },
  {
    domain: "security",
    topic: "Content Security Policy (CSP) Configuration",
    turn1: "How do you construct a strict Content Security Policy (CSP) header for a modern web application that prevents inline script injection using cryptographic nonces (`'nonce-...'`) or hashes?",
    turn2: "How can we deploy CSP in `Content-Security-Policy-Report-Only` mode with a reporting endpoint to detect policy violations before turning on strict enforcement?"
  },

  // 9. Architecture & Distributed Systems (95-99)
  {
    domain: "architecture",
    topic: "Raft Consensus Protocol Leader Election",
    turn1: "Explain how the Raft consensus algorithm handles leader election when the current leader experiences a network partition. How do randomized election timeouts prevent split-vote deadlocks?",
    turn2: "What happens when the partitioned former leader rejoins the cluster with uncommitted log entries, and how does the log matching property ensure state machine safety?"
  },
  {
    domain: "architecture",
    topic: "Event Sourcing and CQRS Pattern",
    turn1: "Explain the architecture of Command Query Responsibility Segregation (CQRS) paired with Event Sourcing. How does the command handler append immutable domain events to the event store?",
    turn2: "How do projection workers consume the event stream to build read-optimized view models, and how do we handle eventual consistency delays in user interfaces?"
  },
  {
    domain: "architecture",
    topic: "Distributed Rate Limiter with Sliding Window Counter",
    turn1: "How does the sliding window counter algorithm approximate rate limits across distributed cluster nodes with lower memory footprint than a sliding log? Provide the mathematical formula.",
    turn2: "Show how to implement this algorithm using Redis pipelined commands (`INCR` and `EXPIRE`) to enforce per-tenant API rate limits efficiently."
  },
  {
    domain: "architecture",
    topic: "Dead Letter Queue (DLQ) and Retry Backoff Policy",
    turn1: "When designing an asynchronous message processing pipeline (e.g., using SQS, RabbitMQ, or Kafka), what factors determine the optimal retry count and exponential backoff curve before routing messages to a Dead Letter Queue (DLQ)?",
    turn2: "How should operational teams monitor the DLQ, and what tooling or administrative workflow should be provided to safely replay poison-pill messages after bug fixes?"
  },
  {
    domain: "architecture",
    topic: "Circuit Breaker Pattern in Microservices",
    turn1: "Explain the three states of the Circuit Breaker pattern (Closed, Open, Half-Open). What failure threshold and sliding time window metrics trigger state transitions?",
    turn2: "Can you provide a clean TypeScript or Python implementation of a Circuit Breaker that wraps an arbitrary async network call and transitions through these states automatically?"
  }
];

/**
 * Returns a realistic developer scenario for a given conversation ID.
 * If id >= 100, cycles through the scenarios with a distinct sub-project identifier.
 */
export function getDeveloperScenario(id) {
  const index = id % DEVELOPER_SCENARIOS.length;
  const base = DEVELOPER_SCENARIOS[index];
  const cycle = Math.floor(id / DEVELOPER_SCENARIOS.length);
  
  if (cycle === 0) {
    return base;
  }
  
  // For runs beyond 100, add project namespace differentiation
  return {
    ...base,
    topic: `${base.topic} (Module ${cycle + 1})`,
    turn1: `[Project Module ${cycle + 1}] ${base.turn1}`,
    turn2: `[Project Module ${cycle + 1}] ${base.turn2}`,
  };
}
