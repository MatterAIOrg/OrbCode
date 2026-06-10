# Contributing to OrbCode CLI

Thanks for your interest in contributing! Bug reports, fixes, docs, and
feature ideas are all welcome.

## Getting set up

Requires **Node.js >= 20**.

```bash
git clone https://github.com/MatterAIOrg/OrbCode.git
cd OrbCode
npm install
npm run build
npm link        # exposes the global `orbcode` command (optional)
```

Useful scripts:

| command             | what it does                                  |
|---------------------|-----------------------------------------------|
| `npm run dev`       | run the TUI from source via tsx (no build)    |
| `npm run build`     | compile `src/` → `dist/`                      |
| `npm run typecheck` | type-check without emitting                   |

## Running the tests

The test scripts run against the compiled output, so build first:

```bash
npm run build
node test-device-auth.mjs   # device-auth flow against a local HTTP mock
node test-ui.mjs            # drives the real TUI with a fake TTY
```

Both should print all `PASS` lines and exit 0.

## Submitting changes

1. Fork the repo and create a branch from `main`.
2. Make your change. Match the existing code style (tabs, no semicolons where
   the surrounding code omits them, strict TypeScript).
3. Make sure `npm run typecheck` passes and the test scripts above still pass.
4. Update README.md if the change is user-visible (new flags, commands,
   settings keys).
5. Open a pull request with a clear description of what changed and why.

## Reporting bugs

Open an issue at <https://github.com/MatterAIOrg/OrbCode/issues> with:

- the output of `orbcode --version` and `node --version`
- your OS and terminal
- steps to reproduce, expected vs. actual behavior

For security vulnerabilities, please **do not** open a public issue — see
[SECURITY.md](SECURITY.md).

## Releases

Releases are cut by maintainers from `release/*` branches; see
[RELEASE.md](RELEASE.md).

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
