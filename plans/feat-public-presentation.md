# Public presentation refresh

Branch: `feat/public-presentation`. Goal: make the public repository and the
Marketplace listing presentable without changing extension behaviour. Every
image is either a real capture from the 1.2.1 verification run or a brand
asset derived from the existing icon.

## Acceptance criteria

- README opens with a hero, badges, a real panel screenshot, and a short
  "at a glance" summary before the long-form content. Existing prose is kept.
- A how-it-works diagram exists as an SVG master and a PNG render, because
  `vsce` rejects SVG images in the Marketplace README.
- Community health reaches 100% on GitHub: code of conduct present, issue
  templates detected as forms.
- The VSIX does not grow: new media is excluded by `.vscodeignore` apart from
  what the README references, and the packaged size is checked.
- `bun run lint` passes; no source or test changes.

## Tasks

- [x] Crop `docs/verification-1.2.1` captures into `media/panel.png` and
      `media/upgrade-preview.png` (real captures, cropped only).
- [x] Author `media/how-it-works.svg` and render `media/how-it-works.png`.
- [x] Generate `media/hero.png` and `media/social-preview.png` (delegated to a
      GPT-6.1-Sol subagent; brand-matched to the icon).
- [x] Add `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1).
- [x] Replace the Markdown bug template with issue forms: bug report and
      feature request; keep the security contact link.
- [x] Add Marketplace `badges` and `pricing` to `package.json`.
- [x] Restructure the README head: hero, badges, screenshot, at-a-glance table,
      diagram, table of contents.
- [x] Add a CHANGELOG line under 1.2.1.
- [x] Verify: `bun run lint`, `vsce ls` shows no new media beyond the icon and
      README-referenced images, package size unchanged within a few KB.
- [ ] Open PR; link it to the thread.

## Proposals for Michael (repo settings, not in this PR)

- Upload `media/social-preview.png` as the GitHub social preview (web UI only).
- Enable GitHub Discussions for questions, keeping issues for bugs.
- Add topics `vscode`, `claude`, `ai`, `amazon-bedrock`.
