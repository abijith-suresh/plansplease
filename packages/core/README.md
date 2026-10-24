# @planview/core

Private pure policy and validation primitives shared by the CLI, local runtime,
and app. Core resolves application-data paths and validates document IDs, source
files, and artifact bundle metadata. It does not inspect, read, or copy source
files and performs no filesystem, network, or cloud I/O.

The source-file policy accepts `.html` and `.htm` up to 10 MiB. The bundle
format requires root `index.html`, uses safe POSIX paths, and allows at most 512
files. See the exported validators and policy constants for the executable
contract.
