const HISTORY_MARKER = "cc-bridge-release-history:";

/** Keep the legacy notes readable; one-line metadata also stays invisible to older clients. */
export function buildUpdateNotes(notes, version, changelog) {
  const releases = [...changelog.matchAll(/^##\s+\[(\d+\.\d+\.\d+)\]\s*-\s*(\S+)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm)]
    .map((match) => ({
      version: match[1], date: match[2],
      body: match[3].replace(/^###\s*(用户摘要|技术细节|实现说明|开发者)\s*\r?\n[\s\S]*?(?=^###\s|$(?![\s\S]))/gm, "").trim(),
    }));
  const parts = (value) => value.split(".").map(Number);
  const compare = (a, b) => {
    const left = parts(a), right = parts(b);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  };
  if (!releases.some((release) => release.version === version)) return notes;
  const entries = releases.filter((release) => compare(release.version, version) <= 0)
    .sort((a, b) => compare(b.version, a.version)).slice(0, 10);
  // A changelog item may itself contain an HTML comment terminator.
  const metadata = JSON.stringify(entries).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `${notes}\n\n<!-- ${HISTORY_MARKER}${metadata} -->`;
}
