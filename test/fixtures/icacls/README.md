# `icacls` captures

**These samples are constructed, not captured from a live Windows box.** This
project is developed on Linux and M6 Part D is explicit that hardware MC does
not have is not to be faked. They are built faithfully from the documented
formats:

- `icacls <file> /save <aclfile>` writes UTF-16LE with a BOM, alternating
  *file name* and *SDDL security descriptor* lines, CRLF-terminated
  (<https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls>).
- SDDL principals are literal SIDs or fixed two-letter aliases — ASCII, defined
  by the SDDL grammar, identical on every locale.
- The `/q` flag suppresses the success summary, but `/c` can still let a
  localised `Successfully processed …` / `… Dateien erfolgreich verarbeitet` /
  `… 個のファイルが正常に処理されました` line through. The `.summary.txt`
  siblings carry those, because the parser has to walk past them.

The whole point of the German and Japanese files (plan Q-AG) is that they
describe the *same DACL* as their English counterpart. If a change makes their
verdicts diverge, the parser has started reading display names.

`.txt` files here are the scratch descriptor; `.stdout.txt` files are what
`icacls` printed to the console for the same call.
