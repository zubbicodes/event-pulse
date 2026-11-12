import type { HTTPResponse, Page } from "puppeteer-core";
import { isInventoryResponseUrl } from "./ticket-inventory.ts";

// Loads one ticket page in an already-open browser tab and records the inventory JSON the page
// fetches for itself while loading. Shared by the monitor (Multilogin profiles) and the local
// live-check script, so both read pages exactly the same way.

const NAVIGATION_TIMEOUT_MS = 20_000;
const TICKETMASTER_IDENTIFY_TIMEOUT_MS = 20_000;
// How long a loaded page may take to fetch its inventory JSON before the check reads what it has.
const INVENTORY_WAIT_MS = 10_000;
const MAX_INVENTORY_PAYLOADS = 12;

export type CapturedTicketPage = {
  html: string;
  statusCode: number;
  responseOk: boolean;
  inventoryPayloads: unknown[];
  // Every JSON response URL the page loaded; diagnostics for the live-check script.
  jsonResponseUrls: string[];
};

export async function captureTicketPage(page: Page, url: string): Promise<CapturedTicketPage> {
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  let latestNavigationStatus: number | null = null;
  const payloadReads: Promise<unknown>[] = [];
  const jsonResponseUrls: string[] = [];
  page.on("response", (response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      latestNavigationStatus = response.status();
      return;
    }
    if (isJson(response)) jsonResponseUrls.push(response.url());
    if (payloadReads.length < MAX_INVENTORY_PAYLOADS && isInventoryResponse(response)) {
      payloadReads.push(response.json().catch(() => null));
    }
  });

  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  if (response?.status() === 401 && isTicketmasterUrl(url)) {
    await waitForTicketmasterIdentification(page);
  }

  const firstStatus = latestNavigationStatus ?? response?.status() ?? 200;
  if (isOk(firstStatus) && isTicketmasterUrl(url) && payloadReads.length === 0) {
    await page
      .waitForResponse((candidate) => isInventoryResponse(candidate), {
        timeout: INVENTORY_WAIT_MS,
      })
      .catch(() => undefined);
  }
  await page.waitForNetworkIdle({ idleTime: 1_000, timeout: 8_000 }).catch(() => undefined);

  const statusCode = latestNavigationStatus ?? firstStatus;
  const inventoryPayloads = (await Promise.all(payloadReads)).filter((payload) => payload != null);
  return {
    html: await page.content(),
    statusCode,
    responseOk: isOk(statusCode),
    inventoryPayloads,
    jsonResponseUrls,
  };
}

export function isTicketmasterUrl(value: string) {
  try {
    return /(^|\.)ticketmaster\.[a-z.]+$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isOk(status: number) {
  return status >= 200 && status < 400;
}

function isJson(response: HTTPResponse) {
  return (response.headers()["content-type"] ?? "").includes("json");
}

function isInventoryResponse(response: HTTPResponse) {
  if (response.status() < 200 || response.status() >= 300) return false;
  return isInventoryResponseUrl(response.url()) && isJson(response);
}

async function waitForTicketmasterIdentification(page: Page) {
  await page
    .waitForFunction(
      () => {
        const bodyText = document.body?.innerText.trim() ?? "";
        return document.title.trim().length > 0 && bodyText !== '{"response":"identify"}';
      },
      { polling: 500, timeout: TICKETMASTER_IDENTIFY_TIMEOUT_MS },
    )
    .catch(() => undefined);
}
