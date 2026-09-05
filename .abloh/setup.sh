#!/usr/bin/env bash
# Written by abloh init. This file is how your project builds.
# It is the single source of truth for the steps abloh runs before it measures your suite,
# and abloh never guesses around it.
# Edit it freely. Plain shell, one step per block. Your coding agent can edit it too.
set -euo pipefail

# step 1: put the package manager on PATH, for your own lifecycle scripts. From pnpm-lock.yaml, pnpm@10.34.4
corepack enable

# step 2: dependencies, from your lockfile. From pnpm-lock.yaml, pnpm@10.34.4
corepack pnpm install --frozen-lockfile

# step 3: your build. From ci.yml::unit-test
pnpm run build

# After this script finishes, your suite runs sealed: no network, no secrets.
