import { chromium, type BrowserContext, type Page } from "playwright";
import sharp from "sharp";

import { BROWSER_PROFILE, UPLOAD_MAX_PX } from "./config.ts";
import { BROWSERS, type Browser } from "./settings.ts";

export class CaptchaError extends Error {
  constructor() {
    super("Google asked for a captcha");
  }
}

export interface LensHit {
  url: string;
  title: string;
  thumb: string | null; // data URI
}

/**
 * Google's interface is requested in English (hl=en), so these labels hold for everyone.
 * The Dutch ones are kept as a fallback for pages that come back in the local language.
 */
const LABEL = {
  rejectCookies: /Reject all|Alles afwijzen/i,
  searchByImage: '[aria-label="Search by image"], [aria-label="Zoeken op afbeelding"]',
  dropZone: /Drag an image here|Sleep een afbeelding hier naartoe/i,
  exactMatches: /Exact matches|Exacte overeenkomsten/i,
};

/**
 * Google Lens in a real browser window with its own profile. Headless browsers get a captcha
 * straight away; a normal window does not. The window opens off-screen, so you can keep
 * working. The upload is a simulated drop: the hidden file input and the file chooser do not
 * respond in this version of Lens.
 */
export class Lens {
  private ctx!: BrowserContext;
  private page!: Page;
  private browser: Browser;

  constructor(browser: Browser) {
    this.browser = browser;
  }

  async open(): Promise<void> {
    try {
      this.ctx = await chromium.launchPersistentContext(BROWSER_PROFILE, {
        headless: false,
        channel: this.browser,
        args: ["--disable-blink-features=AutomationControlled", "--window-position=-3000,-3000", "--no-first-run", "--no-default-browser-check"],
        ignoreDefaultArgs: ["--enable-automation"],
        locale: "en-US",
        viewport: { width: 1280, height: 900 },
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (/distribution .* is not found|not found at|Executable doesn't exist/i.test(msg))
        throw new Error(`${BROWSERS[this.browser]} is not installed. Install it, or pick another browser in Settings.`);
      if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(msg))
        throw new Error("The Bootleg browser profile is in use by another window. Close it and try again.");
      throw e;
    }
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    await this.page.goto("https://www.google.com/?hl=en");
    const consent = this.page.getByRole("button", { name: LABEL.rejectCookies }).first();
    if (await consent.isVisible().catch(() => false)) await consent.click();
  }

  async close(): Promise<void> {
    await this.ctx?.close();
  }

  private assertNoCaptcha(): void {
    if (this.page.url().includes("/sorry/")) throw new CaptchaError();
  }

  /** Thumbnails are inline (data URI) or on gstatic; they are always kept as a data URI. */
  private async thumbAsDataUri(src: string | null): Promise<string | null> {
    if (!src) return null;
    if (src.startsWith("data:image")) return src;
    if (!/^https:\/\/[^/]*gstatic\.com\//.test(src)) return null;
    try {
      const res = await this.page.request.get(src, { timeout: 10_000 });
      if (!res.ok()) return null;
      const type = res.headers()["content-type"] ?? "image/jpeg";
      return `data:${type};base64,${(await res.body()).toString("base64")}`;
    } catch {
      return null;
    }
  }

  /** Exact matches for one photo. */
  async search(file: string): Promise<LensHit[]> {
    const page = this.page;
    const jpg = await sharp(file)
      .rotate()
      .resize(UPLOAD_MAX_PX, UPLOAD_MAX_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    await page.goto("https://www.google.com/?hl=en");
    this.assertNoCaptcha();
    await page.locator(LABEL.searchByImage).first().click();
    const zone = page.getByText(LABEL.dropZone).first();
    await zone.waitFor({ timeout: 15_000 });

    const dt = await page.evaluateHandle((b64: string) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], "photo.jpg", { type: "image/jpeg" }));
      return dt;
    }, jpg.toString("base64"));
    for (const ev of ["dragenter", "dragover", "drop"]) await zone.dispatchEvent(ev, { dataTransfer: dt });

    await page.waitForURL(/\/(search|sorry)/, { timeout: 45_000, waitUntil: "commit" });
    this.assertNoCaptcha();

    // No "Exact matches" tab = no exact matches.
    const exactTab = page.getByRole("link", { name: LABEL.exactMatches }).first();
    const hasExact = await exactTab
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    this.assertNoCaptcha();
    if (!hasExact) return [];

    await exactTab.click();
    await page.waitForURL(/udm=48|\/sorry\//, { timeout: 30_000 });
    this.assertNoCaptcha();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);

    // Thumbnails load lazily (only when in view): scroll a screen at a time to the bottom.
    for (let i = 0; i < 120; i++) {
      const atBottom = await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 0.9);
        return window.scrollY + window.innerHeight >= document.body.scrollHeight - 10;
      });
      await page.waitForTimeout(250);
      if (atBottom) break;
    }
    await page.waitForTimeout(800);

    const cards = await page.locator('a[href^="/goto?url="]').evaluateAll((as) =>
      as.map((a) => ({
        goto: a.getAttribute("href")!,
        title: (a as HTMLElement).innerText.split("\n")[0]?.trim() ?? "",
        thumb: (a.querySelector("img") as HTMLImageElement | null)?.src ?? null,
      }))
    );

    // Result links go through /goto?url=…; the real address is in the redirect.
    const hits: LensHit[] = [];
    for (const c of cards) {
      const res = await page.request.get(`https://www.google.com${c.goto}`, { maxRedirects: 0 });
      const url = res.headers()["location"];
      if (!url || /^https?:\/\/[^/]*google\./.test(url)) continue;
      hits.push({ url, title: c.title, thumb: await this.thumbAsDataUri(c.thumb) });
    }
    return hits;
  }
}
