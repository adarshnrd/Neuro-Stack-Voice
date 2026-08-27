#!/usr/bin/env bash
# Recovery attempt for Neuro_stack_voice
# Run from inside ~/Neuro_stack_voice
#
# This script is NON-DESTRUCTIVE. It only fetches and inspects.
# It will NOT push anything. It prints the restore command at the end
# for you to run yourself once you've verified the content is right.

set -u

TARGET="${1:-8ca6c59074959a11af1928910dad79f857a6b084}"

echo "=== Target commit: $TARGET ==="
if [ ${#TARGET} -ne 40 ]; then
  echo "WARNING: '$TARGET' is not a full 40-character SHA."
  echo "git fetch origin <sha> ONLY works with the complete hash. Get it from:"
  echo "  https://github.com/adarshnrd/Neuro_stack_voice/commit/$TARGET"
  echo ""
fi

echo ""
echo "=== STEP 1: Back up current state before touching anything ==="
git tag -f pre-recovery-backup HEAD 2>&1
echo "Current HEAD tagged as 'pre-recovery-backup' (local only)."
git log --oneline -1 HEAD

echo ""
echo "=== STEP 2: Try to fetch the lost commit by full SHA ==="
if git fetch origin "$TARGET" 2>&1; then
  echo "FETCH SUCCEEDED"
  FETCHED=1
else
  echo "FETCH FAILED (see error above)"
  echo "Common cause: 'Server does not allow request for unadvertised object'"
  echo "-> GitHub is refusing to serve the unreachable object. See STEP 5 fallbacks."
  FETCHED=0
fi

echo ""
echo "=== STEP 3: Did the object land locally? ==="
if git cat-file -e "$TARGET^{commit}" 2>/dev/null; then
  echo "SUCCESS: commit object $TARGET is present locally."
  echo ""
  echo "--- commit details ---"
  git log -1 --format="Author:    %an <%ae>%nAuthorDate:%ad%nCommitter: %cn <%ce>%nSubject:   %s" --date=iso "$TARGET"
  echo ""
  echo "--- history reachable from it (up to 30) ---"
  git log --oneline -30 "$TARGET"
  echo ""
  echo "--- files at that commit (top level) ---"
  git ls-tree --name-only "$TARGET"
  echo ""
  echo "=== STEP 4: Preserve it on a local branch ==="
  git branch -f recovered "$TARGET" 2>&1
  echo "Created local branch 'recovered' pointing at $TARGET"
  echo "Inspect it with:  git checkout recovered"
  echo ""
  echo "############################################################"
  echo "# TO RESTORE master ON GITHUB (destructive - run manually): #"
  echo "############################################################"
  echo ""
  echo "  git checkout -B master $TARGET"
  echo "  git push origin master --force-with-lease"
  echo ""
  echo "Do NOT run that until you have confirmed above that the file"
  echo "list and commit history are actually your project."
else
  echo "NOT RECOVERABLE via fetch: object $TARGET is not available."
  echo ""
  echo "=== STEP 5: Fallbacks to try ==="
  echo ""
  echo "A) Check whether GitHub still renders the commit in the web UI:"
  echo "   https://github.com/adarshnrd/Neuro_stack_voice/commit/$TARGET"
  echo "   If that page LOADS, the object still exists server-side and"
  echo "   GitHub Support can restore it even though fetch is blocked."
  echo ""
  echo "B) Try downloading a snapshot archive of that exact commit"
  echo "   (works sometimes even when fetch does not):"
  echo "   https://github.com/adarshnrd/Neuro_stack_voice/archive/$TARGET.tar.gz"
  echo ""
  echo "C) Try the patch/diff endpoints:"
  echo "   https://github.com/adarshnrd/Neuro_stack_voice/commit/$TARGET.patch"
  echo "   https://github.com/adarshnrd/Neuro_stack_voice/commit/$TARGET.diff"
  echo ""
  echo "D) Recover pull request refs (these often survive history rewrites):"
  echo "   git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'"
  echo "   git branch -a | grep pr/"
  echo ""
  echo "E) Open the GitHub Support ticket for a backup restore."
fi

echo ""
echo "=== DONE (nothing was pushed) ==="
