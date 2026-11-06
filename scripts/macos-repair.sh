#!/bin/bash
# Run with /bin/bash after extracting the complete Apple Silicon repair ZIP.
set -euo pipefail

fail() { printf '\n오류: %s\n' "$*" >&2; exit 1; }
trap 'printf "\n수정이 완료되지 않았습니다. 위 오류를 그대로 전달해 주세요.\n" >&2' ERR

[[ "$(/usr/bin/uname -s)" == Darwin ]] || fail '이 파일은 Apple Silicon Mac 전용입니다.'
[[ "$(/usr/sbin/sysctl -n hw.optional.arm64)" == 1 ]] || fail 'Apple Silicon(M 시리즈) Mac에서 실행해 주세요.'
os_version="$(/usr/bin/sw_vers -productVersion)"
[[ "${os_version%%.*}" -ge 13 ]] || fail 'macOS 13 이상이 필요합니다.'

base="$(cd -P -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_name='Visual Discord Code.app'
app="$base/$app_name"
manifest="$base/macos-repair-manifest.txt"
links="$base/macos-repair-symlinks.txt"
[[ -d "$app" && ! -L "$app" ]] || fail '압축을 모두 푼 뒤 앱과 First-Run.command를 같은 폴더에 두세요.'
[[ -s "$manifest" && -f "$links" ]] || fail '무결성 확인 파일이 없습니다. ZIP 전체를 다시 압축 해제해 주세요.'

printf 'Visual Discord Code — Mac 최초 실행 준비\n'
printf 'Apple 공증이 없는 개인 공유용 앱입니다. 이 앱만 로컬에서 재서명합니다.\n'
printf '1/4 배포 파일과 심볼릭 링크를 확인합니다.\n'

expected_files=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[0-9a-f]{64}\ \  ]] || fail '무결성 목록 형식이 올바르지 않습니다.'
  relative="${line#*  }"
  case "$relative" in "$app_name"/*) ;; *) fail '앱 외부 파일이 무결성 목록에 들어 있습니다.' ;; esac
  case "/$relative/" in */../*|*/./*) fail '잘못된 파일 경로입니다.' ;; esac
  [[ -f "$base/$relative" && ! -L "$base/$relative" ]] || fail "파일이 없거나 올바르지 않습니다: $relative"
  parent="$(cd -P -- "$(/usr/bin/dirname -- "$base/$relative")" && pwd)"
  case "$parent/" in "$app/"*) ;; *) fail '앱 밖으로 연결된 파일은 처리하지 않습니다.' ;; esac
  expected_files=$((expected_files + 1))
done < "$manifest"
actual_files="$(/usr/bin/find "$app" -type f -print | /usr/bin/wc -l | /usr/bin/tr -d '[:space:]')"
[[ "$actual_files" -eq "$expected_files" ]] || fail '앱에 추가되거나 누락된 파일이 있습니다. 원본 ZIP을 다시 압축 해제해 주세요.'

expected_links=0
while IFS=$'\t' read -r relative target extra || [[ -n "$relative" ]]; do
  [[ -n "$relative" && -n "$target" && -z "$extra" ]] || fail '심볼릭 링크 목록 형식이 올바르지 않습니다.'
  case "$relative" in "$app_name"/*) ;; *) fail '앱 외부 링크는 처리하지 않습니다.' ;; esac
  case "/$relative/" in */../*|*/./*) fail '잘못된 링크 경로입니다.' ;; esac
  case "$target" in /*) fail '절대 경로 링크는 처리하지 않습니다.' ;; esac
  [[ -L "$base/$relative" ]] || fail "심볼릭 링크가 손상되었습니다: $relative"
  [[ "$(/usr/bin/readlink "$base/$relative")" == "$target" ]] || fail "심볼릭 링크 대상이 다릅니다: $relative"
  if [[ -d "$base/$relative" ]]; then
    resolved="$(cd -P -- "$base/$relative" && pwd)"
  else
    link_parent="$(/usr/bin/dirname -- "$base/$relative")"
    resolved="$(cd -P -- "$link_parent/$(/usr/bin/dirname -- "$target")" && pwd)"
  fi
  case "$resolved/" in "$app/"*) ;; *) fail '앱 밖으로 연결된 링크는 처리하지 않습니다.' ;; esac
  expected_links=$((expected_links + 1))
done < "$links"
actual_links="$(/usr/bin/find "$app" -type l -print | /usr/bin/wc -l | /usr/bin/tr -d '[:space:]')"
[[ "$actual_links" -eq "$expected_links" ]] || fail '앱의 심볼릭 링크 구성이 다릅니다. ZIP을 다시 압축 해제해 주세요.'

entitlements="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/visual-discord-entitlements.XXXXXX")"
report="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/visual-discord-integrity.XXXXXX")"
trap '/bin/rm -f -- "$entitlements" "$report"' EXIT
if ! (cd -- "$base" && /usr/bin/shasum -a 256 -c "$manifest") > "$report" 2>&1; then
  /bin/cat "$report" >&2
  fail '파일 해시가 다릅니다. 이미 재서명한 앱이라면 원본 ZIP을 새 폴더에 다시 풀어 주세요.'
fi

/bin/cat > "$entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
PLIST

sign() {
  /usr/bin/codesign --force --sign - --timestamp=none --options 0 --entitlements "$entitlements" "$1"
}

printf '2/4 실행 파일과 내부 앱부터 순서대로 로컬 서명을 만듭니다.\n'
binary_count=0
while IFS= read -r -d '' binary; do
  case "$(/usr/bin/file -b "$binary")" in
    Mach-O*)
      /bin/chmod u+x "$binary"
      sign "$binary"
      binary_count=$((binary_count + 1))
      ;;
  esac
done < <(/usr/bin/find "$app/Contents" -type f -print0)
[[ "$binary_count" -gt 0 ]] || fail 'Mac 실행 파일을 찾지 못했습니다.'
while IFS= read -r -d '' bundle; do
  sign "$bundle"
done < <(/usr/bin/find "$app/Contents" -depth -type d \( -name '*.framework' -o -name '*.app' \) -print0)
sign "$app"

printf '3/4 앱 전체와 내부 코드의 서명을 엄격하게 검사합니다.\n'
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"

printf '4/4 검사한 앱의 다운로드 격리 표시를 해제하고 실행합니다.\n'
# Restrict the change to this verified, adjacent app. Never change Gatekeeper globally.
if ! quarantine_error="$(/usr/bin/xattr -dr com.apple.quarantine "$app" 2>&1)"; then
  # An already absent attribute is harmless. Prove absence recursively; do not
  # ignore permission errors or a quarantine attribute which remains in a child.
  remaining_attributes="$(/usr/bin/xattr -lr "$app")" || fail '앱의 다운로드 격리 상태를 확인하지 못했습니다.'
  case "$remaining_attributes" in
    *com.apple.quarantine*)
      printf '%s\n' "$quarantine_error" >&2
      fail '앱의 다운로드 격리 표시를 해제하지 못했습니다.'
      ;;
  esac
fi
/usr/bin/open "$app"
printf '\n최초 실행 준비가 완료되었습니다. 다음부터 Visual Discord Code.app을 여세요.\n'
