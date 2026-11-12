#!/bin/sh
set -eu
VIBEGUIDE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$VIBEGUIDE_ROOT/install.sh"
