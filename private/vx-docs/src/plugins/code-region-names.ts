import { definePlugin } from '@astrojs/starlight/expressive-code'

// Expressive Code makes a code block that scrolls sideways a keyboard stop
// (`tabindex="0"`, `role="region"`) but gives the region no name, so a
// screen reader announces every one as the same bare "region" and axe flags
// the page (landmark-unique). Each such region is named by its frame title,
// or "Code" / "Terminal", plus its place on the page, which keeps names
// unique. The name goes when Expressive Code drops the role again (the
// block stopped scrolling), since `aria-label` is not allowed on a plain
// <pre>. tests/a11y-static.test.ts holds every page with a block to it.
export const REGION_NAMES_MARKER = 'vx-code-region-names'

const SCRIPT = `/* ${REGION_NAMES_MARKER} */
(() => {
  const name = (pre, i) => {
    const frame = pre.closest('figure');
    const title = frame && frame.querySelector('figcaption .title');
    const text = title && title.textContent.trim();
    const kind = frame && frame.classList.contains('is-terminal') ? 'Terminal' : 'Code';
    return (text ? text + ', ' : '') + kind.toLowerCase() + ' block ' + (i + 1);
  };
  const sync = () => {
    document.querySelectorAll('.expressive-code pre').forEach((pre, i) => {
      if (pre.getAttribute('role') === 'region') {
        if (!pre.hasAttribute('aria-label')) {
          pre.setAttribute('aria-label', name(pre, i));
          pre.dataset.vxNamed = '';
        }
      } else if ('vxNamed' in pre.dataset) {
        pre.removeAttribute('aria-label');
        delete pre.dataset.vxNamed;
      }
    });
  };
  new MutationObserver(sync).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['role'],
  });
  sync();
})();`

export function codeRegionNames() {
  return definePlugin({ name: 'vx-code-region-names', jsModules: [SCRIPT] })
}
