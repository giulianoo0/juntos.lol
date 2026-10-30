//! Which site the window carries and what it may reach: the origin that gets
//! the IPC, the handshake it answers, and where a navigation goes.
use url::Url;

pub const DEFAULT_SITE: &str = "https://juntos.lol";

/// Bumped when a command or its payload changes shape; the site refuses an
/// app on another protocol and treats it as absent.
pub const PROTOCOL_VERSION: u32 = 1;

/// The site the window loads: `JUNTOS_URL` in dev, the production one
/// otherwise. Anything but http(s) falls back to production.
pub fn site_origin(env: Option<&str>) -> Url {
    let parsed = env
        .and_then(|raw| Url::parse(raw.trim()).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some());
    let mut url = parsed.unwrap_or_else(|| Url::parse(DEFAULT_SITE).expect("default site"));
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    url
}

/// Hosts of Discord's OAuth pages, which the site's sign-in walks through.
const SIGN_IN_HOSTS: &[&str] = &["discord.com", "www.discord.com"];

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    /// Stays in the window.
    Allow,
    /// Leaves for the system browser.
    External,
    /// Not followed at all.
    Block,
}

/// The window holds the site, the bundled offline page and Discord's sign-in;
/// any other web page opens in the browser.
pub fn navigation(target: &Url, site: &Url) -> Navigation {
    if target.as_str() == "about:blank" {
        return Navigation::Allow;
    }
    match target.scheme() {
        "tauri" => return Navigation::Allow,
        "http" | "https" => {}
        _ => return Navigation::Block,
    }
    if target.origin() == site.origin() || target.host_str() == Some("tauri.localhost") {
        return Navigation::Allow;
    }
    if target.scheme() == "https" && target.host_str().is_some_and(|host| SIGN_IN_HOSTS.contains(&host)) {
        return Navigation::Allow;
    }
    Navigation::External
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_defaults_to_production_and_honours_dev() {
        assert_eq!(site_origin(None).as_str(), "https://juntos.lol/");
        assert_eq!(site_origin(Some("http://localhost:5173")).as_str(), "http://localhost:5173/");
        assert_eq!(site_origin(Some("file:///etc/passwd")).as_str(), "https://juntos.lol/");
        assert_eq!(site_origin(Some("not a url")).as_str(), "https://juntos.lol/");
        assert_eq!(site_origin(Some("")).as_str(), "https://juntos.lol/");
    }

    #[test]
    fn site_drops_path_and_query() {
        assert_eq!(site_origin(Some("https://beta.juntos.lol/sala?x=1")).as_str(), "https://beta.juntos.lol/");
    }

    #[test]
    fn navigation_keeps_the_site_and_the_offline_page() {
        let site = site_origin(None);
        let at = |s: &str| navigation(&Url::parse(s).unwrap(), &site);
        assert_eq!(at("https://juntos.lol/r/ABC"), Navigation::Allow);
        assert_eq!(at("tauri://localhost/index.html"), Navigation::Allow);
        assert_eq!(at("http://tauri.localhost/index.html"), Navigation::Allow);
        assert_eq!(at("https://discord.com/oauth2/authorize?client_id=1"), Navigation::Allow);
    }

    #[test]
    fn navigation_sends_other_pages_out_and_blocks_the_rest() {
        let site = site_origin(None);
        let at = |s: &str| navigation(&Url::parse(s).unwrap(), &site);
        assert_eq!(at("https://github.com/giuli/juntos"), Navigation::External);
        assert_eq!(at("https://juntos.lol.evil.com/"), Navigation::External);
        assert_eq!(at("http://juntos.lol/"), Navigation::External);
        assert_eq!(at("file:///etc/passwd"), Navigation::Block);
        assert_eq!(at("javascript:alert(1)"), Navigation::Block);
    }

    #[test]
    fn about_blank_stays() {
        let site = site_origin(None);
        assert_eq!(navigation(&Url::parse("about:blank").unwrap(), &site), Navigation::Allow);
    }
}
