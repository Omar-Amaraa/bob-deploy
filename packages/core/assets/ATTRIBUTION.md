# Third-party assets

## `eff_large_wordlist.txt`

The EFF Large Wordlist for random passphrases, published by the
[Electronic Frontier Foundation](https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases)
and licensed under
[Creative Commons Attribution 3.0 United States (CC BY 3.0 US)](https://creativecommons.org/licenses/by/3.0/us/).

This file is a reformatting of the original `eff_large_wordlist.txt` (7,776 lines, each
`<5-digit dice roll> <word>`, tab-separated): the dice-roll column has been stripped, leaving one
lowercase word per line, in the original order. No words were added, removed, or changed. The
`eff.org` host is not reachable from this environment's network egress, so the content was pulled
from a byte-for-byte mirror of the same file at
[`ChristopherA/iambic-mnemonic`](https://github.com/ChristopherA/iambic-mnemonic/blob/master/word-lists/eff_large_wordlist-7776.txt)
(also CC BY 3.0 US) rather than eff.org directly; `packages/core/src/security/passphrase.test.ts`
verifies the result is exactly 7,776 unique lowercase words, which is the property this codebase
actually depends on.

Used by `packages/core/src/security/passphrase.ts` to generate the SSH key passphrase (DEC-002) and
recovery-code-adjacent random passphrases with `crypto.randomInt` (no modulo bias).
