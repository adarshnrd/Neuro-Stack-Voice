#!/usr/bin/env bash
# MOVED — this script now lives at scripts/recover.sh (see that file for the
# original, unmodified content — a non-destructive git-history recovery
# helper). This root-level copy is kept only because the tooling used for
# this restructure could not delete files, only edit their content. Safe to
# delete:
#
#   git rm recover.sh
echo "This script has moved to scripts/recover.sh — run it from there." >&2
exit 1
