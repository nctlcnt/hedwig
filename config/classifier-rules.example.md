# Personal classifier rules

Copy this file to `config/classifier-rules.md` (or point `CLASSIFIER_RULES_FILE`
at it) and edit it. Its contents are appended verbatim to the LLM classifier's
system prompt as the highest-priority instructions, so write plain natural
language. Only the OpenAI-compatible (LLM) classifier reads this; the `rule`
provider ignores it. Leave the file empty or delete it to use the defaults.

Categories the classifier can assign: action, fyi, course, admin, junk.
These rules influence category, importance, and summary — they also feed the
`cleanup` pass, because deletability is decided per category and age.

## Examples (replace with your own)

- Mail from my supervisor (jane@uni.edu) is almost always `action`, even if it
  looks like an FYI. Bump its importance.
- Anything from `noreply@deals.shop.com` or `promotions@*` is `junk`.
- Calendar invites and meeting reminders are `action` when they need an RSVP,
  otherwise `fyi`.
- Bank statements, receipts, and tax documents are `admin` and should keep a
  high importance even though no reply is needed.
- Course announcements from Canvas/Moodle are `course`; lecture recordings and
  readings are `course` too.
- Newsletters I actually read (e.g. from `weekly@thatblog.com`) are `fyi`, not
  `junk`, so they survive cleanup a little longer.
