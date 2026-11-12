import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { captureTicketPage } from "./page-capture.server.ts";

// Local development only: EVENTPULSE_LOCAL_BROWSER=chrome (or a path to a Chrome/Edge executable)
// makes ticket checks open pages in a normal, visible Chrome window on this computer instead of a
// Multilogin profile, for running the portal with `npm run dev` on a machine without the
// Multilogin agent. Never set in production.

let browserPromise: Promise<Browser> | null = null;

export function localBrowserEnabled() {
  return Boolean(process.env["EVENTPULSE_LOCAL_BROWSER"]?.trim());
}

export async function readWithLocalBrowser(url: string) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const { jsonResponseUrls: _diagnostics, ...captured } = await captureTicketPage(page, url);
    return captured;
  } finally {
    await page.close().catch(() => undefined);
  }
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        executablePath: resolveExecutable(),
        headless: false,
        userDataDir: mkdtempSync(join(tmpdir(), "hd1-local-browser-")),
        defaultViewport: null,
        args: ["--no-first-run", "--no-default-browser-check"],
      })
      .then((browser) => {
        browser.on("disconnected", () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((error: unknown) => {
        browserPromise = null;
        throw error;
      });
  }
  return browserPromise;
}

function resolveExecutable() {
  const configured = process.env["EVENTPULSE_LOCAL_BROWSER"]?.trim() ?? "";
  const candidates = [
    configured && configured !== "chrome" ? configured : "",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found)
    throw new Error("EVENTPULSE_LOCAL_BROWSER is set but no Chrome executable was found.");
  return found;
}
