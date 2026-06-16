import { expect, test } from '@playwright/test';

test('static markdown layout contains hostile tables and SVGs inside the canvas', async ({
  page
}) => {
  await page.goto('/v2/welcome');
  await expect(page.getByRole('heading', { name: 'IronClaw Desktop' })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const host = document.createElement('section');
    host.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:360px',
      'max-width:360px',
      'overflow:visible',
      'visibility:hidden'
    ].join(';');
    host.innerHTML = `
      <div class="markdown-body">
        <table>
          <tr>
            <th>Clause</th>
            <th>Hostile generated content</th>
          </tr>
          <tr>
            <td>1</td>
            <td>${'very-long-generated-token-'.repeat(80)}</td>
          </tr>
        </table>
        <svg width="2400" height="120" viewBox="0 0 2400 120">
          <rect width="2400" height="120"></rect>
        </svg>
      </div>
    `;
    document.body.appendChild(host);

    const table = host.querySelector('table');
    const svg = host.querySelector('svg');
    const result = {
      hostClientWidth: host.clientWidth,
      hostScrollWidth: host.scrollWidth,
      tableClientWidth: table?.clientWidth || 0,
      tableScrollWidth: table?.scrollWidth || 0,
      svgWidth: svg?.getBoundingClientRect().width || 0
    };
    host.remove();
    return result;
  });

  expect(metrics.hostClientWidth).toBe(360);
  expect(metrics.hostScrollWidth).toBeLessThanOrEqual(metrics.hostClientWidth + 1);
  expect(metrics.tableClientWidth).toBeLessThanOrEqual(metrics.hostClientWidth + 1);
  expect(metrics.tableScrollWidth).toBeGreaterThan(metrics.tableClientWidth);
  expect(metrics.svgWidth).toBeLessThanOrEqual(metrics.hostClientWidth + 1);
});
