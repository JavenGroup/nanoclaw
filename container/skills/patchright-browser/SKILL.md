---
name: patchright-browser
description: Anti-detection browser for sites that block automation (Xiaohongshu, Taobao, etc). Uses Patchright (undetected Playwright fork) with real macOS GPU. Prefer this over agent-browser when sites block or show blank pages.
allowed-tools: Bash(patchright-browser:*)
---

# Patchright Browser (Anti-Detection)

Undetected browser based on Patchright — a Playwright fork that patches CDP leaks.
Use this instead of `agent-browser` when sites detect and block automation.

## When to use

- Site shows blank page or CAPTCHA with `agent-browser`
- Site known to block bots: xiaohongshu.com, taobao.com, etc.
- Need real browser fingerprint (WebGL, Canvas, plugins)

## Commands

```bash
# Navigate
patchright-browser open <url>           # Open URL (headed, visible in VM)
patchright-browser close                # Close browser

# Extract data
patchright-browser text <url>           # Get visible text
patchright-browser html <url>           # Get full HTML
patchright-browser screenshot <url>     # Screenshot to /tmp/

# Interact with current page (after open)
patchright-browser click "<selector>"   # Click element (CSS selector)
patchright-browser type "<selector>" <text>  # Type into input
patchright-browser eval "<javascript>"  # Run JavaScript

# Status
patchright-browser status               # Show browser state
```

## Examples

### Browse a protected site

```bash
patchright-browser open "https://www.xiaohongshu.com/explore"
patchright-browser screenshot
patchright-browser text
```

### Fill and submit a form

```bash
patchright-browser open "https://example.com/login"
patchright-browser type "#username" "myuser"
patchright-browser type "#password" "mypass"
patchright-browser click "button[type=submit]"
patchright-browser screenshot
```

### Extract data with JavaScript

```bash
patchright-browser open "https://example.com/products"
patchright-browser eval "Array.from(document.querySelectorAll('.product-title')).map(e => e.textContent)"
```

## Notes

- Browser runs headed (visible in VM window) — this is intentional for anti-detection
- Uses real macOS GPU for WebGL/Canvas fingerprinting
- Language set to zh-CN, timezone Asia/Shanghai
- No `navigator.webdriver` flag, no CDP detection leaks
- Only available in Lume VM runtime (not in containers)
