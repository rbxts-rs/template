# rbxts-rs Template

A minimal Roblox game in TypeScript, built with `rbxtsc` from [rbxts-rs](https://github.com/rbxts-rs/rbxts-rs): the
roblox-ts compiler rewritten in Rust on TypeScript 7. It compiles to the same Luau as roblox-ts 3.0.0 and takes the
same arguments.

## Install

You need [Node](https://nodejs.org) 18 or newer, [bun](https://bun.sh) (or npm) and
[Rokit](https://github.com/rojo-rbx/rokit) for Rojo, plus the Rojo plugin for Studio.

```sh
git clone <this repository> my-game
cd my-game
rokit install
bun install
bun run build
rojo serve
```

The first `bun run build` downloads the project's compiler (about 8 MB, checked against its SHA-256) into
`compiler/bin/`. Later builds start at once. Open a place in Studio (a new Baseplate will do), connect from the Rojo
plugin and press Play: the output prints a hello from the server and the client.

- `bun run watch`: rebuilds as you edit.
- `bun run typecheck`: TypeScript 7's check.
- `bun run place`: builds `place.rbxl`.
- `bun run format`: formats `src/`.

## The compiler: `compiler/`

The project carries its own compiler in `compiler/`:
- a small Cargo package (`rbxts_cli` pinned to an exact rbxts-rs release, plus any plugins);
- `rbxtsc.mjs`, the launcher that `bun run build` runs.

The binary itself is not committed (`compiler/bin/` is git-ignored):
- **Prebuilt binary:** when `compiler/` is unchanged and a prebuilt one exists for your platform (`preset.json`;
  Windows x64 for now), the launcher downloads it.
- **Otherwise:** when you've added a plugin, or you're on another platform, it offers to build the binary with Rust
  (`node compiler/rbxtsc.mjs --build`, a few minutes). It needs [rustup](https://rustup.rs); the Rust version comes
  from `compiler/rust-toolchain.toml`.

`node compiler/rbxtsc.mjs --where` shows which binary a build uses and why. See `compiler/README.md` for adding
plugins and upgrading.

## Versions

| `compiler/` (rbxts-rs) | roblox-ts | TypeScript | `@rbxts/compiler-types` |
| --- | --- | --- | --- |
| 0.1.2 | 3.0.0 | 7.1 | 3.0.0-types.1-ts7.0 ([release](https://github.com/rbxts-rs/compiler-types/releases/tag/v3.0.0-types.1-ts7.0)) |

Every version here is exact. To upgrade the compiler, take `templates/compiler/` from the rbxts-rs release you want
(its `Cargo.toml`, `Cargo.lock` and `preset.json` change together) and keep your plugins in `src/main.rs`.

## Differences from a roblox-ts 3.0.0 project

- **TypeScript 7.1 rules:** options TypeScript 7 removed are errors.
  - `baseUrl`: use `paths`, as `tsconfig.json` does.
  - Automatic `types`: list them, as `"types": ["types", "compiler-types"]` does.
- **Compiler types:** `@rbxts/compiler-types` comes from the TypeScript 7 build linked above, not from npm.
- **Editor:** use the "TypeScript 7" extension (`TypeScriptTeam.native-preview`, recommended in `.vscode/`). The
  built-in TypeScript 5 service misreads this project.
- **Diagnostics** print in TypeScript 7's layout.
