// Fetching a web page a user gave (an item's web link) from the server,
// without letting the link reach anything that isn't the public internet:
// only http(s), only ports 80/443, and every address the name resolves to
// is checked when connecting (so a name can't point at the app's own
// machine, Fly's private network or a cloud metadata address, before or
// after a redirect). The page is read up to a size limit, with a timeout.

import http from 'http';
import https from 'https';
import dns from 'dns';
import net from 'net';
import zlib from 'zlib';

/** Whether an IP address is private, loopback, link-local or otherwise not the public internet. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)   // carrier-grade NAT
      || (a === 169 && b === 254)             // link-local, cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('2001:db8');
  }
  return true;
}

/** A name lookup that refuses names resolving to non-public addresses. */
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...(options as dns.LookupOptions), all: true }, (err, addresses: any) => {
    if (err) return (callback as any)(err);
    const list: dns.LookupAddress[] = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (!list.length || bad) return (callback as any)(Object.assign(new Error(`${hostname} is not a public address`), { code: 'EPRIVATE' }));
    if ((options as any)?.all) return (callback as any)(null, list);
    (callback as any)(null, list[0].address, list[0].family);
  });
};

export class PageFetchError extends Error {}

/** Checks a link may be fetched at all; returns it as a URL. */
export function publicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new PageFetchError('That is not a web address.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PageFetchError('Only http and https links can be read.');
  if (url.username || url.password) throw new PageFetchError('Links with a user name in them are not read.');
  if (url.port && url.port !== '80' && url.port !== '443') throw new PageFetchError('Only links on the usual web ports are read.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host) ? isPrivateAddress(host) : (!host.includes('.') || /(\.|^)(localhost|internal|local|lan|home|flycast)$/.test(host))) {
    throw new PageFetchError('That link is not on the public internet.');
  }
  return url;
}

export interface FetchedPage { status: number; url: string; html: string }

/** Fetches a public page: up to 4 redirects, 3 MB and 15 seconds. */
export async function fetchPublicPage(raw: string, { maxBytes = 3_000_000, timeoutMs = 15_000, maxRedirects = 4 } = {}): Promise<FetchedPage> {
  let url = publicUrl(raw);
  for (let hop = 0; ; hop++) {
    const page = await new Promise<FetchedPage & { location?: string }>((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(url, {
        method: 'GET',
        lookup: publicLookup,
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-ZA,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, url: url.toString(), html: '', location: res.headers.location });
        }
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        const body = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        body.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) { req.destroy(); body.destroy(); resolve({ status, url: url.toString(), html: Buffer.concat(chunks).toString('utf8') }); return; }
          chunks.push(c);
        });
        body.on('end', () => resolve({ status, url: url.toString(), html: Buffer.concat(chunks).toString('utf8') }));
        body.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new PageFetchError('The site took too long to answer.')));
      req.on('error', (err: any) => reject(err?.code === 'EPRIVATE' ? new PageFetchError('That link is not on the public internet.') : err));
      req.end();
    });
    if (!page.location) return page;
    if (hop >= maxRedirects) throw new PageFetchError('The link redirects too many times.');
    url = publicUrl(new URL(page.location, url).toString());
  }
}
