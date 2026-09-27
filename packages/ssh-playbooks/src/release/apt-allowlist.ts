/**
 * A8 step 7 ("install_runtime") needs to filter Bob's `plan_install` suggestions before anything is
 * installed as root. `scripts/helpers/allowlist.txt` is *not* that list — it's the sudoers/helper
 * allowlist (absolute paths to the bd-* binaries, consumed by 40-install-helpers.sh). There was no
 * existing mechanism for constraining which *system apt packages* Bob may ask for, so this module
 * introduces one: a small fixed list of build-time native dependencies that are common, safe and
 * genuinely needed to build some Python/Node native extensions, kept in sync by hand with the
 * ALLOWED_PACKAGES bash array in scripts/helpers/bd-install-apt-packages (which re-validates
 * independently — defense in depth, since a script must never trust its caller alone).
 */
export const APT_PACKAGE_ALLOWLIST: readonly string[] = [
  'build-essential',
  'libssl-dev',
  'libffi-dev',
  'zlib1g-dev',
  'libjpeg-dev',
  'libpq-dev',
  'libxml2-dev',
  'libxslt1-dev',
  'pkg-config',
  'python3-dev',
];

export interface FilterAptPackagesResult {
  allowed: string[];
  dropped: string[];
}

/**
 * Filters an InstallPlan's aptPackages against APT_PACKAGE_ALLOWLIST, de-duplicating and dropping
 * anything not on the list. Dropped packages are returned (never installed) so the caller can log
 * them plainly, per the brief ("dropped ones logged plainly") — this never throws, since an
 * over-eager suggestion from Bob is an expected, non-fatal event, not a failure of the step.
 */
export function filterAptPackages(requested: readonly string[]): FilterAptPackagesResult {
  const allowedSet = new Set(APT_PACKAGE_ALLOWLIST);
  const seen = new Set<string>();
  const allowed: string[] = [];
  const dropped: string[] = [];
  for (const pkg of requested) {
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    if (allowedSet.has(pkg)) {
      allowed.push(pkg);
    } else {
      dropped.push(pkg);
    }
  }
  return { allowed, dropped };
}
