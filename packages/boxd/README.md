# @computesdk/boxd

[boxd](https://boxd.sh) provider for ComputeSDK - isolated Linux computers on their own microVMs that boot in milliseconds, with snapshots, volumes and HTTPS URLs for any port.

## Installation

```bash
npm install @computesdk/boxd
```

## Setup

1. Create an API key in the [boxd console](https://app.boxd.sh), or with the CLI: `boxd auth keys create computesdk --org <your-org>`
2. Set the environment variables:

```bash
export BOXD_API_KEY=bxd_your_api_key
export BOXD_ORG=your-org
```

`BOXD_ORG` is the org the key belongs to. A key or token passed in the config wins over `BOXD_TOKEN` and `BOXD_API_KEY` in the environment.

New computers and volumes go to New York (`nyc`). For Frankfurt, set `BOXD_REGION=fra` or pass `region: 'fra'`.

## Quick Start

```typescript
import { compute } from 'computesdk';
import { boxd } from '@computesdk/boxd';

compute.setConfig({
  provider: boxd({ apiKey: process.env.BOXD_API_KEY, org: process.env.BOXD_ORG }),
});

const sandbox = await compute.instances.create();

const result = await sandbox.runCommand('node -v && python3 --version');
console.log(result.stdout);

await sandbox.destroy();
```

Or call the provider factory directly:

```typescript
import { boxd } from '@computesdk/boxd';

const sdk = boxd({ apiKey: process.env.BOXD_API_KEY, org: process.env.BOXD_ORG });
const sandbox = await sdk.instances.create({ vcpus: 4, timeout: 60 * 60 * 1000 });

// Save the computer as it is, then start new ones from it
const snapshot = await sdk.snapshot!.create(sandbox.instanceId, { name: 'golden' });
const copy = await sdk.instances.create({ snapshotId: snapshot.id });
```

### Volumes

A volume is a boxd disk: it keeps its files when the computer that used it is destroyed.

```typescript
const volume = await sdk.volume!.create({ name: 'cache', sizeBytes: 10 * 1024 ** 3 });

const first = await sdk.instances.create({ volumes: [{ volume, mountPath: '/data' }] });
await first.runCommand('echo kept > /data/note');
await first.destroy();

const second = await sdk.instances.create({ volumes: [{ volume, mountPath: '/data' }] });
console.log((await second.runCommand('cat /data/note')).stdout); // kept
```

### Port URLs

```typescript
const sandbox = await sdk.instances.create({ ports: [3000] });
await sandbox.runCommand('python3 -m http.server 3000', { background: true });

// https://p3000.<name>.nyc.boxd.sh, already answering when getUrl returns
const url = await sandbox.getUrl({ port: 3000 });
```

## Configuration

```typescript
interface BoxdConfig {
  /** boxd API key - defaults to BOXD_API_KEY */
  apiKey?: string;
  /** boxd session token, used instead of an API key - defaults to BOXD_TOKEN */
  token?: string;
  /** Org to create and list computers in - defaults to BOXD_ORG */
  org?: string;
  /** Region for new computers and volumes: `nyc` (New York) or `fra` (Frankfurt) - defaults to BOXD_REGION, then `nyc`. Lists cover every region unless it is set. */
  region?: string;
  /** API endpoint - defaults to BOXD_BASE_URL, then boxd production */
  baseURL?: string;
  /** Default lifetime of a computer in milliseconds, for a create without `timeout`. Unset: until it is destroyed. */
  timeout?: number;
  /** Deadline for each call to the boxd API, in milliseconds */
  requestTimeout?: number;
  /** Seconds idle before a computer is suspended (the next request wakes it). 0 never suspends; unset uses your org's default. */
  autoSuspendTimeout?: number;
  /** How long getUrl waits for a new URL to answer, in milliseconds. Default 90000; 0 returns at once. */
  urlReadyTimeout?: number;
}
```

## Create Options

| Option | Maps to | Notes |
|---|---|---|
| `vcpus` (or `cpu`, `cpus`) | `config.vcpu` | 1, 2 (default), 4 or 8. |
| `memoryMiB` (or `memory`, `memoryMb`, `memMiB`) | `config.memory` | 4096, 8192, 16384 or 32768. Every vCPU comes with 4 GiB, so either field names the whole size. |
| `snapshotId` (or `templateId`) | `fromSnapshot` | Starts as the snapshot was captured, with its size, in the snapshot's region. |
| `timeout` | `deleteAfter` | Milliseconds until the computer is deleted, whatever it is doing. |
| `region` | `region` | `nyc` or `fra`, for this computer only. Defaults to the config's `region`, then `nyc`. |
| `volumes` | `config.volumes` | `[{ volume, mountPath, readOnly? }]`. boxd places the computer next to its disks, so they must share a region. |
| `ports` | `config.proxies` | A named route per port from the start, so its certificate is issued while the computer boots. |
| `envs` | | Stored in the computer (`~/.computesdk/env`, readable by its user only) and read by every command, also after `getById`. A snapshot of the computer keeps them. |
| `metadata` | `labels` | Keys are lowercased and other characters become `-`, so `userId` is stored as `userid`. A value that isn't a string is stored as JSON. |
| `name` | `name` | Unique in the org. Default `computesdk-<8 hex>`. |

`sizeClass` is reported as unsupported: the standard classes give each vCPU 1 or 2 GiB, and boxd gives it 4. `image` is refused: computers boot from the boxd base image (Ubuntu 24.04 with Docker, Node, Python, Go and git), so set one up, snapshot it, and create from the snapshot. `runtime` needs nothing: Node, Python and Go are all installed.

## Features

- **Isolated computers**: every computer is created with `isolated: true`, which removes the in-machine boxd CLI, integrations and account access from it
- **Commands** with `cwd`, `env` and background commands (in a session of their own, so they outlive the call), and exit code 124 when a `timeout` runs out, with the output printed until then
- **Live output**: `onStdout`/`onStderr` stream over boxd's exec API, with no port to expose
- **Interactive processes**: `startProcess` with stdin, output callbacks and `kill`
- **Filesystem**: read, write, list, mkdir, exists and remove through boxd's file API. A relative path starts in the home directory, `/home/boxd`.
- **Port URLs**: `getUrl({ port })` returns `https://p<port>.<name>.<zone>` once it answers: a computer's first URL waits about 20 seconds for its certificate, a later one about a second. An existing named route on the port is reused, and `ws`/`wss` give a `wss://` URL. Port URLs are public.
- **Snapshots**: `snapshot.create` (it waits for the version it captured), `list` and `delete`, and `create({ snapshotId })`. `snapshot.list({ instanceId })` returns the snapshots this provider named for that computer; boxd doesn't link a snapshot you named yourself to the computer it came from.
- **Volumes**: `volume.create`, `get`, `list` and `delete` on boxd disks (ext4, 10 GiB unless `sizeBytes` says otherwise), mounted with `create({ volumes })` or `attachVolume`. `create` checks that every volume mounted. boxd mounts and releases a computer's disks when it boots, so `attachVolume` and `detachVolume` restart a running computer. Before the provider stops or destroys a computer, its disks are written out and left clean, so a file written just before is kept and the next read-only mount works.
- **Regions**: new computers and volumes go to New York (`nyc`) unless `region` or `BOXD_REGION` names another, such as Frankfurt (`fra`). `getById`, `destroy` and the snapshot calls find a computer or snapshot in any region of the org.
- **Persistence**: a computer keeps its disk until you destroy it, and a stopped one is started again by the next command

## Limitations

- Computers don't expire on their own. Call `destroy()`, or pass `timeout` at create (or in the config).
- `attachVolume` works when the computer runs on the volume's host. `create({ volumes })` always does, since boxd places the computer there.
- A read-only mount fails if the computer that last wrote to the disk was stopped some other way, for example with the boxd CLI: `create` then says so. Mount it read-write once, and read-only works again.
- Commands and files run as the user `boxd`. Use `sudo` in a command for anything outside its reach.
- Custom images are not supported: use snapshots.
- Needs Node.js 20 or newer.

## Links

- [boxd docs](https://docs.boxd.sh)
- [TypeScript SDK reference](https://docs.boxd.sh/reference/typescript-sdk)
