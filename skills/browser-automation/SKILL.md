---
name: browser-automation
description: "AI-powered browser automation using Stagehand. Use when: natural language page interaction, structured data extraction, observing actionable elements on unknown/dynamic pages. Activates on: 'act on page', 'extract from', 'observe elements', 'scrape', 'interact with browser', 'fill form', 'click button'."
---

# Browser Automation with Stagehand

## Prerequisites

Chrome remote debugging must be enabled: `chrome-debug check`
If not responding: `chrome-debug open` -> toggle remote debugging ON.

## Tools Available

- `start` -- Create browser session (auto-connects to local Chrome via CDP)
- `navigate` -- Go to URL
- `act` -- Natural language action: "click the login button", "scroll to bottom"
- `observe` -- Find actionable elements: "find all product cards with prices"
- `extract` -- Structured data extraction: "get all prices and titles as JSON"
- `end` -- Close session

## When to Use This vs playwright-cli

- **This (Stagehand)**: Unknown/dynamic UIs, natural language, resilient to DOM changes
- **playwright-cli**: Known pages, deterministic selectors, dev server testing, E2E test suites

## Workflow

1. Ensure Chrome CDP is active: `chrome-debug check`
2. Start a session (tool: `start`)
3. Navigate to target page (tool: `navigate`)
4. Observe or act on elements using natural language
5. Extract structured data if needed
6. End session when done
