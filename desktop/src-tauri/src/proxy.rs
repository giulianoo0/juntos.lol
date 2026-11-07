//! The site's way to media the browser cannot read: no CORS, plain http, a
//! port, or a CDN that wants a Referer or a User-Agent. The page reads
//! `<media root>/_proxy?u=<url>&k=<key>&h=<headers>`; the key comes only over
//! IPC, so an extension's frame (same webview, no IPC) cannot use it. Reads go
//! out on the person's own network and never to an address on it.
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use tauri::http::{header, HeaderValue, Method, Request, Response, StatusCode};
use url::Url;

const HEADER_NAMES: [&str; 3] = ["user-agent", "referer", "origin"];
const MAX_HEADER: usize = 512;
const MAX_REDIRECTS: usize = 5;
const MAX_PLAYLIST: usize = 4 << 20;
/// A read without Range is a segment or a probe; a whole film is never asked for at once.
const MAX_BODY: usize = 256 << 20;
const DEFAULT_AGENT: &str = "Mozilla/5.0 (juntos)";
const PASS_HEADERS: [header::HeaderName; 6] = [
    header::CONTENT_TYPE,
    header::CONTENT_LENGTH,
    header::CONTENT_RANGE,
    header::ACCEPT_RANGES,
    header::ETAG,
    header::LAST_MODIFIED,
];

pub struct MediaProxy {
    key: String,
    client: reqwest::Client,
}

impl MediaProxy {
    pub fn new() -> Self {
        let key: [u8; 24] = rand::random();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(Arc::new(PublicOnly))
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .build()
            .expect("proxy client");
        Self {
            key: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key),
            client,
        }
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub async fn handle(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        if request.method() == Method::OPTIONS {
            return reply(StatusCode::NO_CONTENT)
                .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "range")
                .body(Vec::new())
                .expect("response");
        }
        if request.method() != Method::GET && request.method() != Method::HEAD {
            return empty(StatusCode::METHOD_NOT_ALLOWED);
        }
        let Some(asked) = Asked::parse(request.uri()) else {
            return empty(StatusCode::BAD_REQUEST);
        };
        if !same(asked.key.as_bytes(), self.key.as_bytes()) {
            return empty(StatusCode::FORBIDDEN);
        }
        let range = request.headers().get(header::RANGE).cloned();
        let method = request.method().clone();
        let response = match self
            .fetch(asked.url.clone(), &method, range.as_ref(), &asked.headers)
            .await
        {
            Ok(response) => response,
            Err(status) => return empty(status),
        };
        let (url, response) = response;
        let status =
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let mut builder = reply(status);
        for name in PASS_HEADERS {
            if let Some(value) = response
                .headers()
                .get(name.as_str())
                .and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok())
            {
                builder = builder.header(name, value);
            }
        }
        if method == Method::HEAD {
            return builder.body(Vec::new()).expect("response");
        }
        let playlist = status.is_success() && is_playlist(&url, response.headers());
        let cap = if playlist {
            MAX_PLAYLIST
        } else if range.is_some() {
            usize::MAX
        } else {
            MAX_BODY
        };
        let Some(body) = read_capped(response, cap).await else {
            return empty(StatusCode::BAD_GATEWAY);
        };
        if playlist {
            let text = String::from_utf8_lossy(&body);
            let rewritten = rewrite_playlist(
                &text,
                &url,
                &asked.base(request.uri()),
                &self.key,
                asked.raw_headers.as_deref(),
            );
            return reply(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
                .body(rewritten.into_bytes())
                .expect("response");
        }
        builder.body(body).expect("response")
    }

    /// Follows redirects itself, so each hop is checked like the first.
    async fn fetch(
        &self,
        mut url: Url,
        method: &Method,
        range: Option<&HeaderValue>,
        headers: &[(&'static str, String)],
    ) -> Result<(Url, reqwest::Response), StatusCode> {
        for _ in 0..=MAX_REDIRECTS {
            if !reachable(&url) {
                return Err(StatusCode::FORBIDDEN);
            }
            let method = reqwest::Method::from_bytes(method.as_str().as_bytes())
                .map_err(|_| StatusCode::BAD_REQUEST)?;
            let mut request = self.client.request(method, url.clone());
            if !headers.iter().any(|(name, _)| *name == "user-agent") {
                request = request.header("user-agent", DEFAULT_AGENT);
            }
            for (name, value) in headers {
                request = request.header(*name, value);
            }
            if let Some(range) = range {
                request = request.header("range", range.as_bytes());
            }
            let response = request.send().await.map_err(|e| {
                tracing::warn!(host = url.host_str().unwrap_or_default(), error = %e, "media proxy read failed");
                StatusCode::BAD_GATEWAY
            })?;
            if !response.status().is_redirection() {
                return Ok((url, response));
            }
            let next = response
                .headers()
                .get("location")
                .and_then(|l| l.to_str().ok())
                .and_then(|l| url.join(l).ok());
            url = next.ok_or(StatusCode::BAD_GATEWAY)?;
        }
        Err(StatusCode::BAD_GATEWAY)
    }
}

struct Asked {
    url: Url,
    key: String,
    headers: Vec<(&'static str, String)>,
    raw_headers: Option<String>,
}

impl Asked {
    fn parse(uri: &tauri::http::Uri) -> Option<Self> {
        let query = Url::parse(&format!("http://x/?{}", uri.query()?)).ok()?;
        let (mut url, mut key, mut raw_headers) = (None, None, None);
        for (name, value) in query.query_pairs() {
            match name.as_ref() {
                "u" => url = Url::parse(&value).ok(),
                "k" => key = Some(value.into_owned()),
                "h" => raw_headers = Some(value.into_owned()),
                _ => {}
            }
        }
        let headers = match &raw_headers {
            Some(raw) => parse_headers(raw)?,
            None => Vec::new(),
        };
        Some(Self {
            url: url?,
            key: key?,
            headers,
            raw_headers,
        })
    }

    /// Where the page reached this proxy: `juntos-media://localhost`, or
    /// `http://juntos-media.localhost` on Windows.
    fn base(&self, uri: &tauri::http::Uri) -> String {
        let scheme = uri.scheme_str().unwrap_or(crate::serve::SCHEME);
        let authority = uri.authority().map(|a| a.as_str()).unwrap_or("localhost");
        format!("{scheme}://{authority}")
    }
}

/// `h` is base64url JSON of at most the allowed headers.
fn parse_headers(raw: &str) -> Option<Vec<(&'static str, String)>> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw.trim_end_matches('='))
        .ok()?;
    let object: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(&bytes).ok()?;
    let mut out = Vec::new();
    for (name, value) in object {
        let name = HEADER_NAMES
            .into_iter()
            .find(|known| known.eq_ignore_ascii_case(&name))?;
        let value = value.as_str()?;
        if value.len() > MAX_HEADER
            || value.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0)
            || out.iter().any(|(n, _)| *n == name)
        {
            return None;
        }
        out.push((name, value.to_string()));
    }
    Some(out)
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// http or https, no credentials, and not an address written as local.
fn reachable(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(domain)) => {
            let domain = domain.to_ascii_lowercase();
            domain != "localhost" && !domain.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => public(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => public(IpAddr::V6(ip)),
        None => false,
    }
}

/// An address on the internet, not this machine, its network or a range that never routes.
fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

/// Resolves names as the system does and keeps only public addresses: a name
/// that points into the person's network resolves to nothing.
struct PublicOnly;

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let found: Vec<SocketAddr> = tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .filter(|addr| public(addr.ip()))
                .collect();
            if found.is_empty() {
                return Err("no public address".into());
            }
            Ok(Box::new(found.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn is_playlist(url: &Url, headers: &reqwest::header::HeaderMap) -> bool {
    let typed = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.to_ascii_lowercase().contains("mpegurl"));
    typed || url.path().ends_with(".m3u8")
}

async fn read_capped(mut response: reqwest::Response, cap: usize) -> Option<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|len| len as usize > cap)
    {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > cap {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    Some(body)
}

/// Every uri of the playlist through this proxy, with the same key and headers.
fn rewrite_playlist(
    text: &str,
    base: &Url,
    proxy: &str,
    key: &str,
    headers: Option<&str>,
) -> String {
    let proxied = |reference: &str| -> String {
        let Ok(url) = base.join(reference) else {
            return reference.to_string();
        };
        let mut out = format!(
            "{proxy}/_proxy?u={}&k={}",
            encode(url.as_str()),
            encode(key)
        );
        if let Some(h) = headers {
            out.push_str("&h=");
            out.push_str(&encode(h));
        }
        out
    };
    text.split('\n')
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                line.to_string()
            } else if trimmed.starts_with('#') {
                rewrite_uri_attributes(line, &proxied)
            } else {
                proxied(trimmed)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn rewrite_uri_attributes(line: &str, proxied: &impl Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find("URI=\"") {
        let (head, tail) = rest.split_at(at + 5);
        out.push_str(head);
        let Some(end) = tail.find('"') else {
            out.push_str(tail);
            return out;
        };
        out.push_str(&proxied(&tail[..end]));
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn reply(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Range, Content-Length, Accept-Ranges",
        )
        .header(header::CACHE_CONTROL, "no-store")
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    reply(status).body(Vec::new()).expect("response")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(json: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
    }

    #[test]
    fn local_addresses_never_go_out() {
        for raw in [
            "http://127.0.0.1/a",
            "http://10.0.0.2/a",
            "http://192.168.1.1/a",
            "http://172.20.0.1/a",
            "http://169.254.169.254/latest",
            "http://100.90.3.117/a",
            "http://0.0.0.0/a",
            "http://[::1]/a",
            "http://[fd00::1]/a",
            "http://[fe80::1]/a",
            "http://[::ffff:127.0.0.1]/a",
            "http://localhost:8080/a",
            "http://cam.localhost/a",
            "file:///etc/passwd",
            "ftp://cdn.example.com/a",
            "https://u:p@cdn.example.com/a",
        ] {
            assert!(!reachable(&Url::parse(raw).unwrap()), "{raw}");
        }
        for raw in [
            "http://cdn.example.com:8080/a.m3u8",
            "https://8.8.8.8/a",
            "https://[2606:4700::1111]/a",
        ] {
            assert!(reachable(&Url::parse(raw).unwrap()), "{raw}");
        }
    }

    #[test]
    fn only_the_allowed_headers_pass() {
        let ok = parse_headers(&b64(
            r#"{"Referer":"https://site.example/","user-agent":"VLC/3"}"#,
        ))
        .unwrap();
        assert_eq!(
            ok,
            vec![
                ("referer", "https://site.example/".to_string()),
                ("user-agent", "VLC/3".to_string())
            ]
        );
        assert!(parse_headers(&b64(r#"{"cookie":"a=b"}"#)).is_none());
        assert!(parse_headers(&b64(r#"{"referer":"a\r\nx-evil: 1"}"#)).is_none());
        assert!(parse_headers(&b64(r#"{"referer":"a","Referer":"b"}"#)).is_none());
        assert!(parse_headers(&b64(r#"{"referer":7}"#)).is_none());
        assert!(parse_headers("não é base64").is_none());
    }

    #[test]
    fn the_request_needs_url_and_key() {
        let uri = |q: &str| {
            format!("juntos-media://localhost/_proxy?{q}")
                .parse::<tauri::http::Uri>()
                .unwrap()
        };
        let asked = Asked::parse(&uri("u=http%3A%2F%2Fcdn.example.com%2Fa.ts&k=abc")).unwrap();
        assert_eq!(asked.url.as_str(), "http://cdn.example.com/a.ts");
        assert_eq!(asked.key, "abc");
        assert_eq!(asked.base(&uri("u=x&k=y")), "juntos-media://localhost");
        assert!(Asked::parse(&uri("k=abc")).is_none());
        assert!(Asked::parse(&uri("u=http%3A%2F%2Fcdn.example.com%2Fa.ts")).is_none());
        assert!(Asked::parse(&uri(&format!(
            "u=http%3A%2F%2Fa.example%2F&k=a&h={}",
            b64(r#"{"cookie":"x"}"#)
        )))
        .is_none());
    }

    #[test]
    fn a_playlist_points_back_here_with_key_and_headers() {
        let base = Url::parse("http://cdn.example.com:8080/live/index.m3u8?t=1").unwrap();
        let text = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\nseg1.ts?t=1\n\n#EXTINF:6,\nhttps://other.example/seg2.ts\n#EXT-X-ENDLIST";
        let out = rewrite_playlist(text, &base, "juntos-media://localhost", "K", Some("h1"));
        let proxied = |u: &str| format!("juntos-media://localhost/_proxy?u={}&k=K&h=h1", encode(u));
        assert_eq!(
            out.split('\n').collect::<Vec<_>>(),
            vec![
                "#EXTM3U".to_string(),
                format!(
                    "#EXT-X-MAP:URI=\"{}\"",
                    proxied("http://cdn.example.com:8080/live/init.mp4")
                ),
                "#EXTINF:6,".to_string(),
                proxied("http://cdn.example.com:8080/live/seg1.ts?t=1"),
                String::new(),
                "#EXTINF:6,".to_string(),
                proxied("https://other.example/seg2.ts"),
                "#EXT-X-ENDLIST".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn a_wrong_key_reads_nothing() {
        let proxy = MediaProxy::new();
        let request = Request::builder()
            .uri("juntos-media://localhost/_proxy?u=https%3A%2F%2Fcdn.example.com%2Fa.ts&k=errada")
            .body(Vec::new())
            .unwrap();
        assert_eq!(proxy.handle(&request).await.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_name_that_points_home_resolves_to_nothing() {
        use reqwest::dns::Resolve;
        let name: reqwest::dns::Name = "localhost".parse().unwrap();
        assert!(PublicOnly.resolve(name).await.is_err());
    }
}
