#!/usr/bin/env python3
"""Manually publish a production build of the orbcode package to npm.

Usage:
    NPM_TOKEN=npm_xxx python3 release.py            # publish current package.json version
    NPM_TOKEN=npm_xxx python3 release.py --dry-run  # show what would be uploaded, no publish

The token is passed to npm via an .npmrc placeholder (${NPM_TOKEN}) that npm
expands from the environment at runtime, so the token itself is never written
to disk. `prepublishOnly` (typecheck + build) runs automatically as part of
`npm publish`, so a stale dist/ can't ship.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
REGISTRY = "registry.npmjs.org"


def run(cmd, **kwargs):
    print(f"$ {' '.join(cmd)}")
    return subprocess.run(cmd, cwd=ROOT, **kwargs)


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Publish orbcode to npm")
    parser.add_argument("--dry-run", action="store_true",
                        help="run npm pack --dry-run instead of publishing")
    args = parser.parse_args()

    if not os.environ.get("NPM_TOKEN"):
        fail("NPM_TOKEN is not set in the environment")

    with open(os.path.join(ROOT, "package.json")) as f:
        pkg = json.load(f)
    name, version = pkg["name"], pkg["version"]
    spec = f"{name}@{version}"
    print(f"Releasing {spec}")

    # Abort if this version is already on npm (npm view exits non-zero for
    # missing versions, including a never-published package).
    view = run(["npm", "view", spec, "version"],
               capture_output=True, text=True)
    if view.returncode == 0 and view.stdout.strip() == version:
        fail(f"{spec} already exists on npm — bump the version in package.json first")

    if args.dry_run:
        result = run(["npm", "pack", "--dry-run"])
        sys.exit(result.returncode)

    # npm expands ${NPM_TOKEN} from the environment when reading .npmrc,
    # so only the placeholder is written to the temp file.
    with tempfile.NamedTemporaryFile("w", suffix=".npmrc", delete=False) as npmrc:
        npmrc.write(f"//{REGISTRY}/:_authToken=${{NPM_TOKEN}}\n")
        npmrc_path = npmrc.name

    try:
        env = {**os.environ, "NPM_CONFIG_USERCONFIG": npmrc_path}
        result = subprocess.run(
            ["npm", "publish", "--access", "public"],
            cwd=ROOT, env=env,
        )
        if result.returncode != 0:
            fail("npm publish failed")
    finally:
        os.unlink(npmrc_path)

    print(f"\nPublished {spec} — verify with: npm view {spec}")


if __name__ == "__main__":
    main()
