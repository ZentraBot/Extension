import { DomUtils, parseDocument } from 'htmlparser2';

export const rsiOrigin = 'https://robertsspaceindustries.com';
const maxDocumentBytes = 1024 * 1024;
const pledgePath = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?account\/pledges\/?$/i;
type Element = ReturnType<typeof DomUtils.findAll>[number];
type Tree = Parameters<typeof DomUtils.findAll>[1];
export type RsiAccount = { accountKey: string; label: string };
export type RsiPledge = {
  pledgeId: string;
  name: string;
  contains: string;
  availability: string;
  dateText: string;
  rawValue: string;
  rawConfigurationValue: string;
  currency: string;
  giftable: boolean;
  meltable: boolean;
  items: { title: string; kind: string; manufacturer: string }[];
  alsoContains: string[];
};

function hasClass(node: Element, value: string) {
  return node.attribs.class?.split(/\s+/).includes(value) ?? false;
}

const byClass = (nodes: Tree, classname: string) =>
  DomUtils.findAll((node) => hasClass(node, classname), nodes);

function textOf(node?: Element) {
  return node ? DomUtils.textContent(node).trim().replace(/\s+/g, ' ') : '';
}

function valuesFor(row: Element): RsiPledge {
  const text = (classname: string) => textOf(byClass(row.children, classname)[0]);
  const input = (classname: string) =>
    byClass(row.children, classname)[0]?.attribs.value?.trim() || '';
  const extra = byClass(row.children, 'more').filter((node) => hasClass(node, 'items'));
  const withImages = extra.flatMap((node) => byClass(node.children, 'with-images'));
  const withoutImages = extra.flatMap((node) => byClass(node.children, 'without-images'));
  const items = withImages.flatMap((node) =>
    byClass(node.children, 'item').map((item) => {
      const details = byClass(item.children, 'text')[0]?.children || [];
      return {
        title: textOf(byClass(details, 'title')[0]),
        kind: textOf(byClass(details, 'kind')[0]),
        manufacturer: textOf(byClass(details, 'liner')[0]).replace(/[()]/g, ''),
      };
    }),
  );
  const pledgeId = input('js-pledge-id');
  const name =
    input('js-pledge-name') ||
    textOf(
      DomUtils.findAll(
        (node) => node.name === 'h3',
        byClass(row.children, 'title-col')[0]?.children || [],
      )[0],
    );
  if (!pledgeId || !name || items.some((item) => !item.title))
    throw new Error('rsi_page_unverified');
  return {
    pledgeId,
    name,
    contains: text('items-col').replace(/^Contains:\s*/i, ''),
    availability: text('availability'),
    dateText: text('date-col').replace(/^Created:\s*/i, ''),
    rawValue: input('js-pledge-value'),
    rawConfigurationValue: input('js-pledge-configuration-value'),
    currency: input('js-pledge-currency'),
    giftable: byClass(row.children, 'js-gift').length > 0,
    meltable: byClass(row.children, 'js-reclaim').length > 0,
    items,
    alsoContains: withoutImages.flatMap((node) =>
      byClass(node.children, 'item')
        .flatMap((item) => byClass(item.children, 'title').map(textOf))
        .filter(Boolean),
    ),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sourceIdentity(nodes: Tree) {
  const platform = DomUtils.findAll(
    (node) => Boolean(node.attribs['data-platform-client-props']),
    nodes,
  )[0];
  if (!platform) throw new Error('rsi_account_unverified');
  let profile: Record<string, unknown>;
  try {
    const props: unknown = JSON.parse(platform.attribs['data-platform-client-props']);
    profile = asObject(asObject(props).user);
  } catch {
    throw new Error('rsi_account_unverified');
  }
  if (profile.isSignedIn === false) throw new Error('rsi_sign_in_required');
  if (profile.isSignedIn !== true) throw new Error('rsi_account_unverified');
  const handle = typeof profile.handle === 'string' ? profile.handle.trim() : '';
  const id = typeof profile.accountId === 'string' ? profile.accountId.trim() : '';
  if (id && /^[\w-]{1,120}$/.test(id) && handle && /^[\w-]{1,64}$/.test(handle)) {
    return { identifier: `id:${id}`, label: `@${handle}` };
  }
  if (handle && /^[\w-]{1,64}$/.test(handle)) {
    return { identifier: `handle:${handle.toLowerCase()}`, label: `@${handle}` };
  }
  const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
  const match = /^([^@\s]{1,64})@([^@\s]{1,190})$/.exec(email);
  if (!match) {
    if (id && /^[\w-]{1,120}$/.test(id))
      return { identifier: `id:${id}`, label: `RSI account …${id.slice(-6)}` };
    throw new Error('rsi_account_unverified');
  }
  return {
    identifier: id && /^[\w-]{1,120}$/.test(id) ? `id:${id}` : `email:${email}`,
    label: `${match[1].slice(0, 2)}…@${match[2]}`,
  };
}

function pageIn(link: string, base: URL) {
  try {
    const url = new URL(link, base);
    if (
      url.origin !== rsiOrigin ||
      !pledgePath.test(url.pathname) ||
      url.searchParams.get('product-type')
    )
      return undefined;
    const page = Number(url.searchParams.get('page') || 1);
    return Number.isSafeInteger(page) && page > 0 ? page : undefined;
  } catch {
    return undefined;
  }
}

/** Decode only an authenticated pledge document and return allowlisted values for the import. */
export async function parseRsiPage(
  html: string,
  responseUrl: URL,
  requested: number,
  salt: string,
) {
  const nodes = parseDocument(html).children;
  const identity = sourceIdentity(nodes);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${salt}\0${identity.identifier}`),
  );
  const account = {
    accountKey: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
    label: identity.label,
  };
  const pagers = byClass(nodes, 'pager');
  const anchors = pagers.flatMap((pager) =>
    DomUtils.findAll((node) => node.name === 'a', pager.children),
  );
  const canonical = DomUtils.findAll(
    (node) => node.name === 'link' && node.attribs.rel === 'canonical',
    nodes,
  )[0]?.attribs.href;
  const active = anchors.find((node) => hasClass(node, 'active'));
  const marker = canonical ? pageIn(canonical, responseUrl) : undefined;
  const activePage = active ? Number(textOf(active)) : undefined;
  if (
    (marker !== undefined && marker !== requested) ||
    (activePage !== undefined && activePage !== requested) ||
    (requested > 1 && marker === undefined && activePage === undefined)
  ) {
    throw new Error('rsi_page_unverified');
  }
  const total = Math.max(
    requested,
    ...anchors.map((anchor) => pageIn(anchor.attribs.href, responseUrl) || 0),
  );
  const list = byClass(nodes, 'list-items')[0];
  const rows = list
    ? DomUtils.findAll((node) => node.name === 'li' && node.parent === list, list.children)
    : [];
  const empties = list
    ? [...byClass(list.children, 'empty-list'), ...byClass(list.children, 'empy-list')]
    : [];
  const empty =
    requested === 1 &&
    total === 1 &&
    empties.some((marker) =>
      /^(your hangar is empty|you have no pledges)\.?$/i.test(textOf(marker)),
    );
  const pledgeRows = empty
    ? rows.filter((row) => !empties.some((marker) => marker === row || marker.parent === row))
    : rows;
  if ((!pledgeRows.length && !empty) || (pledgeRows.length > 0 && empty))
    throw new Error('rsi_page_unverified');
  return { account, total, empty, pledges: pledgeRows.map(valuesFor) };
}

async function readBounded(response: Response) {
  if (!response.body) throw new Error('rsi_fetch_failed');
  const reader = response.body.getReader();
  const decode = new TextDecoder();
  let bytes = 0;
  let html = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return html + decode.decode();
    bytes += value.byteLength;
    if (bytes > maxDocumentBytes) {
      await reader.cancel();
      throw new Error('rsi_page_unverified');
    }
    html += decode.decode(value, { stream: true });
  }
}

/** Fetch one current RSI page, including cookies only for the browser's RSI session. */
export async function fetchRsiPage(page: number, salt: string, signal?: AbortSignal) {
  const url = new URL(`/account/pledges?page=${page}`, rsiOrigin);
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(url.href, {
    credentials: 'include',
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const finalUrl = response.url ? new URL(response.url) : url;
  if (
    response.status === 401 ||
    response.status === 403 ||
    finalUrl.origin !== rsiOrigin ||
    !pledgePath.test(finalUrl.pathname)
  ) {
    throw new Error('rsi_sign_in_required');
  }
  if (!response.ok) throw new Error('rsi_fetch_failed');
  return parseRsiPage(await readBounded(response), finalUrl, page, salt);
}
