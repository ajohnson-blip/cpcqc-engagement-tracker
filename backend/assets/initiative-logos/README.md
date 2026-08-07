# Initiative logos for CE certificates

Drop logo files here and the CE certificate renderer picks them up automatically —
no code change, no redeploy beyond the usual push.

## Filenames

Lowercase program code, `.png` preferred (`.jpg`/`.jpeg` also work):

| File | Used for |
|---|---|
| `cpcqc.png` | CPCQC mark — appears on every certificate (already present) |
| `spark.png` | SPARK |
| `soar.png` | SOAR |
| `nest.png` | NEST |
| `ttt.png` | Turning the Tide |
| `impact.png` | IMPACT |

## Requirements

- **PNG or JPEG only.** pdfkit cannot embed SVG. If you only have an SVG, export
  it to PNG at 2–3× the display size.
- **Transparent background** (PNG) so the logo sits cleanly on the certificate.
- **At least ~600px wide.** The host logo is drawn into a 150×58pt box and the
  CPCQC logo into 130×58pt; at 300dpi that's roughly 625×240px. Larger is fine —
  the renderer scales down and preserves aspect ratio.

## What happens if a logo is missing

The certificate still renders: the program name is set in type where the logo
would go. The staff UI flags the missing logo before you send, and
`GET /staff/ce/programs` lists them in `missingLogos`.

Adding a new CE program: add it to `CE_PROGRAMS` in
`backend/src/modules/ce/ce-programs.ts` and drop its logo here. No migration —
`ce_trainings.program_code` is a text column for exactly this reason.
