#!/usr/bin/env bash
set -euo pipefail

retry_cmd() {
  local attempts="$1"
  local delay_seconds="$2"
  shift 2

  local i
  local exit_code
  for ((i = 1; i <= attempts; i++)); do
    if "$@"; then
      return 0
    fi
    exit_code=$?
    if [ "$i" -lt "$attempts" ]; then
      echo "Command failed (attempt $i/$attempts, exit=$exit_code): $*" >&2
      echo "Retrying in ${delay_seconds}s..." >&2
      sleep "$delay_seconds"
    fi
  done

  echo "Command failed after $attempts attempts: $*" >&2
  return "$exit_code"
}

capture_cmd_with_retry() {
  local result_var="$1"
  local attempts="$2"
  local delay_seconds="$3"
  shift 3

  local i
  local output=""
  local exit_code=1
  for ((i = 1; i <= attempts; i++)); do
    if output="$("$@" 2>/dev/null)"; then
      printf -v "$result_var" "%s" "$output"
      return 0
    fi
    exit_code=$?
    if [ "$i" -lt "$attempts" ]; then
      echo "Capture command failed (attempt $i/$attempts, exit=$exit_code): $*" >&2
      echo "Retrying in ${delay_seconds}s..." >&2
      sleep "$delay_seconds"
    fi
  done

  echo "Capture command failed after $attempts attempts: $*" >&2
  return "$exit_code"
}

wait_for_release_id() {
  local repo="$1"
  local tag="$2"
  local attempts="${3:-12}"
  local delay_seconds="${4:-2}"

  local i
  local release_id
  local release_api_url
  for ((i = 1; i <= attempts; i++)); do
    release_id="$(gh api "repos/$repo/releases/tags/$tag" --jq '.id' 2>/dev/null || true)"
    if [[ "$release_id" =~ ^[0-9]+$ ]]; then
      echo "$release_id"
      return 0
    fi

    release_id="$(gh release view "$tag" --repo "$repo" --json databaseId --jq '.databaseId // empty' 2>/dev/null || true)"
    if [[ "$release_id" =~ ^[0-9]+$ ]]; then
      echo "$release_id"
      return 0
    fi

    release_api_url="$(gh release view "$tag" --repo "$repo" --json apiUrl --jq '.apiUrl // empty' 2>/dev/null || true)"
    if [[ "$release_api_url" =~ /releases/([0-9]+)$ ]]; then
      echo "${BASH_REMATCH[1]}"
      return 0
    fi

    if [ "$i" -lt "$attempts" ]; then
      echo "Release id for tag '$tag' is not ready yet (attempt $i/$attempts), retrying in ${delay_seconds}s..." >&2
      sleep "$delay_seconds"
    fi
  done

  echo "Unable to fetch release id for tag '$tag' after $attempts attempts." >&2
  gh release view "$tag" --repo "$repo" --json databaseId,id,isDraft,isPrerelease,url 2>/dev/null || true
  gh api "repos/$repo/releases/tags/$tag" --jq '{draft: .draft, prerelease: .prerelease, url: .html_url}' 2>/dev/null || true
  return 1
}

settle_release_state() {
  local repo="$1"
  local release_id="$2"
  local tag="$3"
  local attempts="${4:-12}"
  local delay_seconds="${5:-2}"
  local endpoint="repos/$repo/releases/tags/$tag"

  local i
  local draft_state
  local prerelease_state
  for ((i = 1; i <= attempts; i++)); do
    gh release edit "$tag" --repo "$repo" --draft=false --prerelease >/dev/null 2>&1 || true
    gh api --method PATCH "repos/$repo/releases/$release_id" -F draft=false -F prerelease=true >/dev/null 2>&1 || true
    draft_state="$(gh api "$endpoint" --jq '.draft' 2>/dev/null || gh release view "$tag" --repo "$repo" --json isDraft --jq '.isDraft' 2>/dev/null || echo true)"
    prerelease_state="$(gh api "$endpoint" --jq '.prerelease' 2>/dev/null || gh release view "$tag" --repo "$repo" --json isPrerelease --jq '.isPrerelease' 2>/dev/null || echo false)"
    if [ "$draft_state" = "false" ] && [ "$prerelease_state" = "true" ]; then
      return 0
    fi
    if [ "$i" -lt "$attempts" ]; then
      echo "Release '$tag' state not settled yet (attempt $i/$attempts), retrying in ${delay_seconds}s..." >&2
      sleep "$delay_seconds"
    fi
  done

  echo "Failed to settle release state for tag '$tag'." >&2
  gh release view "$tag" --repo "$repo" --json isDraft,isPrerelease,url 2>/dev/null || true
  gh api "$endpoint" --jq '{draft: .draft, prerelease: .prerelease, url: .html_url}' 2>/dev/null || true
  return 1
}

print_release_state() {
  local repo="$1"
  local tag="$2"

  gh api "repos/$repo/releases/tags/$tag" --jq '{isDraft: .draft, isPrerelease: .prerelease, url: .html_url}' 2>/dev/null \
    || gh release view "$tag" --repo "$repo" --json isDraft,isPrerelease,url --jq '{isDraft: .isDraft, isPrerelease: .isPrerelease, url: .url}'
}

wait_for_release_absent() {
  local repo="$1"
  local tag="$2"
  local attempts="${3:-12}"
  local delay_seconds="${4:-2}"

  local i
  for ((i = 1; i <= attempts; i++)); do
    if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
      if [ "$i" -lt "$attempts" ]; then
        echo "Release '$tag' still exists (attempt $i/$attempts), waiting ${delay_seconds}s..." >&2
        sleep "$delay_seconds"
      fi
      continue
    fi
    return 0
  done

  echo "Release '$tag' still exists after waiting." >&2
  gh release view "$tag" --repo "$repo" --json url,isDraft,isPrerelease 2>/dev/null || true
  return 1
}

wait_for_git_tag_absent() {
  local repo="$1"
  local tag="$2"
  local attempts="${3:-12}"
  local delay_seconds="${4:-2}"

  local i
  for ((i = 1; i <= attempts; i++)); do
    if gh api "repos/$repo/git/ref/tags/$tag" >/dev/null 2>&1; then
      if [ "$i" -lt "$attempts" ]; then
        echo "Git tag '$tag' still exists (attempt $i/$attempts), waiting ${delay_seconds}s..." >&2
        sleep "$delay_seconds"
      fi
      continue
    fi
    return 0
  done

  echo "Git tag '$tag' still exists after waiting." >&2
  gh api "repos/$repo/git/ref/tags/$tag" --jq '{ref: .ref, object: .object.sha}' 2>/dev/null || true
  return 1
}

recreate_fixed_prerelease() {
  local repo="$1"
  local tag="$2"
  local target_branch="$3"
  local release_title="$4"
  local release_notes="$5"

  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    retry_cmd 5 3 gh release delete "$tag" --repo "$repo" --yes --cleanup-tag
  fi

  wait_for_release_absent "$repo" "$tag" 12 2

  if gh api "repos/$repo/git/ref/tags/$tag" >/dev/null 2>&1; then
    retry_cmd 5 2 gh api --method DELETE "repos/$repo/git/refs/tags/$tag"
  fi

  wait_for_git_tag_absent "$repo" "$tag" 12 2

  local created="false"
  local i
  for ((i = 1; i <= 6; i++)); do
    if gh release create "$tag" --repo "$repo" --title "$release_title" --notes "$release_notes" --prerelease --target "$target_branch"; then
      created="true"
      break
    fi
    if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
      echo "Release '$tag' appears to exist after create failure; continue to settle state." >&2
      created="true"
      break
    fi
    if [ "$i" -lt 6 ]; then
      echo "Create release '$tag' failed (attempt $i/6), retrying in 3s..." >&2
      sleep 3
    fi
  done

  if [ "$created" != "true" ]; then
    echo "Failed to create release '$tag'." >&2
    return 1
  fi

  local release_id
  release_id="$(wait_for_release_id "$repo" "$tag" 12 2)"
  settle_release_state "$repo" "$release_id" "$tag" 12 2
}

upload_release_assets_with_retry() {
  local repo="$1"
  local tag="$2"
  shift 2

  if [ "$#" -eq 0 ]; then
    echo "No release assets provided for upload." >&2
    return 1
  fi

  wait_for_release_id "$repo" "$tag" 12 2 >/dev/null
  retry_cmd 5 3 gh release upload "$tag" "$@" --repo "$repo" --clobber
}
