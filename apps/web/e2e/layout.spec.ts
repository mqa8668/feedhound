// Layout matrix.
// Requires @playwright/test + @axe-core/playwright as devDependencies and a
// running stack (`docker compose -p feedhound`, api NODE_ENV=development) with an
// operator dev session (X-Dev-User). Screenshots saved to test-results/layout/.
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "390x844", width: 390, height: 844 },
] as const;

const ROUTES = ["/matches", "/sources", "/watches", "/watches/new", "/health"] as const;

const TABLE_ROUTES = new Set(["/sources"]);

async function gotoAsOperator(page: Page, route: string) {
  await page.setExtraHTTPHeaders({ "X-Dev-User": process.env.VITE_DEV_USER ?? "operator@example.com" });
  await page.goto(route);
  await page.waitForLoadState("networkidle");
}

for (const viewport of VIEWPORTS) {
  test.describe(`layout @ ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of ROUTES) {
      test(`${route} has no horizontal scroll, correct shell variant, single h1`, async ({ page }) => {
        await gotoAsOperator(page, route);

        // No horizontal overflow.
        const scrollWidth = await page.evaluate(() => document.scrollingElement?.scrollWidth ?? 0);
        expect(scrollWidth).toBeLessThanOrEqual(viewport.width);

        // Exactly one shell variant visible.
        const sidebarVisible = await page.locator("aside.lg\\:flex").isVisible().catch(() => false);
        const railVisible = await page
          .locator("aside.md\\:flex.lg\\:hidden")
          .isVisible()
          .catch(() => false);
        const bottomNavVisible = await page
          .locator('nav[aria-label="Primary"].md\\:hidden')
          .isVisible()
          .catch(() => false);

        if (viewport.width >= 1024) {
          expect(sidebarVisible).toBe(true);
          expect(railVisible).toBe(false);
          expect(bottomNavVisible).toBe(false);
        } else if (viewport.width >= 768) {
          expect(sidebarVisible).toBe(false);
          expect(railVisible).toBe(true);
          expect(bottomNavVisible).toBe(false);
        } else {
          expect(sidebarVisible).toBe(false);
          expect(railVisible).toBe(false);
          expect(bottomNavVisible).toBe(true);
        }

        // Exactly one h1; topbar doesn't repeat it at >=768.
        const h1s = page.locator("h1");
        await expect(h1s).toHaveCount(1);
        const h1Text = (await h1s.first().textContent())?.trim();
        if (viewport.width >= 768 && h1Text) {
          // Only the elements actually rendered (offsetParent !== null) count as "shown" text;
          // the <768 title span stays in the DOM but is display:none at wider widths.
          const visibleTopbarText = await page.locator("header").first().evaluate((header) => {
            const isVisible = (el: Element) => (el as HTMLElement).offsetParent !== null;
            const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
            let text = "";
            let node = walker.nextNode();
            while (node) {
              const parent = node.parentElement;
              if (parent && isVisible(parent)) text += node.textContent ?? "";
              node = walker.nextNode();
            }
            return text;
          });
          expect(visibleTopbarText.includes(h1Text)).toBe(false);
        }

        // DataTable pages collapse to cards under 640px, and render a
        // <table> at >=640px, but only when the table actually has rows
        // (an empty DataTable renders neither, just an EmptyState).
        if (TABLE_ROUTES.has(route)) {
          const tableVisible = await page
            .locator("table")
            .first()
            .isVisible()
            .catch(() => false);

          if (viewport.width < 640) {
            expect(tableVisible).toBe(false);
          } else {
            const rowCount = await page.locator("table tbody tr").count();
            expect(tableVisible).toBe(rowCount > 0);
          }
        }

        await page.screenshot({ path: `test-results/layout/${viewport.name}${route.replace(/\//g, "_") || "_root"}.png`, fullPage: true });
      });
    }

    // Content box + symmetric gaps at 1440x900.
    if (viewport.width === 1440) {
      for (const route of ROUTES) {
        test(`${route} content is centered with equal gaps at 1440x900`, async ({ page }) => {
          await gotoAsOperator(page, route);
          const main = page.locator("main");
          const box = await main.boundingBox();
          expect(box).not.toBeNull();
          if (!box) return;
          const maxWidth = 1280;
          expect(box.width).toBeLessThanOrEqual(maxWidth + 1);

          const sidebarBox = await page.locator("aside.lg\\:flex").boundingBox();
          const containerLeft = sidebarBox ? sidebarBox.x + sidebarBox.width : 0;
          const leftGap = box.x - containerLeft;
          const rightGap = viewport.width - (box.x + box.width);
          expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
        });
      }
    }
  });
}

test.describe("focus ring + a11y", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`nav focus ring only on keyboard, axe clean (${colorScheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await gotoAsOperator(page, "/matches");

      const firstNavLink = page.locator('aside nav a, nav[aria-label="Primary"] a').first();
      await firstNavLink.click();
      const clickOutline = await firstNavLink.evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(clickOutline).toBe("none");

      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      const focused = page.locator(":focus-visible");
      const focusOutline = await focused
        .first()
        .evaluate((el) => getComputedStyle(el).outlineWidth)
        .catch(() => "0px");
      expect(focusOutline).not.toBe("0px");

      for (const route of ROUTES) {
        await gotoAsOperator(page, route);
        const results = await new AxeBuilder({ page }).analyze();
        const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(serious).toEqual([]);
      }
    });
  }
});
