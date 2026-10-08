# Third-party notices

## DeepSeek Harness (design tokens in the console stylesheet)

`web/app.css` adapts the design tokens (colour scales, spacing, radii, type scale) of the DeepSeek
Harness console (<https://github.com/deepseek-ai/deepseek-harness>, `ui-theme/design-platform.css`),
rebound to Switchboard's own palette, with Switchboard's own control-room styling added after them.
No DeepSeek logos, mascot assets or runtime code are used. Switchboard is not affiliated with or
endorsed by DeepSeek. The original licence, as required, follows verbatim:

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Dependencies

Runtime dependencies keep their own licences (see `package-lock.json`): notably Cordis (MIT),
`@modelcontextprotocol/sdk` (MIT) and `yaml` (ISC).

## Conventions, not code

The CLI and console conventions (project `AGENTS.md` injection, `sbx doctor`, the context gauge) were
reviewed against Hermes Agent and OpenClaw (both MIT). Ideas only; no code was copied.
