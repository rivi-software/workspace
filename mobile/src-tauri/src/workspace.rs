//! Where the workspace is, and what the app does with each URL it is asked to open.
//!
//! The app is a web view on a workspace as its Worker serves it; it bundles no copy of the
//! workspace, and it knows of no workspace of its own: every deployment of Workspace has an address
//! of its own. The person names theirs on the start page the first time the app opens (endpoint.rs
//! keeps it). A build may name one in its configuration, `plugins.workspace.url`, which the app
//! opens while the person has named none: `pnpm run app:dev` and `ios:dev` merge
//! tauri.local.conf.json (`http://localhost:5174`), `android:dev` tauri.emulator.conf.json
//! (`http://10.0.2.2:5174`, the emulator's name for the computer it runs on), and a deployment
//! that builds the app for its own people can name its address in tauri.conf.json. The Tauri CLI
//! carries a merged configuration into Xcode's and Gradle's builds, where an environment variable
//! of ours would not reach the Rust build.

use std::collections::HashMap;

use url::{Host, Url};

/// Where the app's own start page is served from: `tauri://localhost` in WebKit (iPhone, Mac),
/// `http://tauri.localhost` in the Android System WebView (and `WebView2`).
const START_PAGE_HOST: &str = "tauri.localhost";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    start: Url,
}

/// What happens to a navigation in the app's web view.
#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    /// The web view loads it.
    Stay,
    /// The system opens it with the app registered for its scheme (Mail for `mailto:`, Phone for
    /// `tel:`).
    System,
    /// Nothing opens it.
    Refuse,
}

/// What happens to a page's request for a new window (`target="_blank"`, `window.open`). The app
/// has one web view, so a workspace page asked for opens in it, as a tap would.
#[derive(Debug, PartialEq, Eq)]
pub enum NewWindow {
    /// The app's web view loads it in place.
    Here,
    /// The phone's browser opens it.
    Browser,
    /// The system opens it with the app registered for its scheme.
    System,
    /// Nothing opens it.
    Refuse,
}

impl Workspace {
    /// The workspace this build names in `plugins.workspace.url` (`config.plugins.0`), if any.
    ///
    /// # Panics
    ///
    /// When the configuration names an address [`Workspace::parse`] refuses: the build is
    /// broken, and opening the wrong site would be worse.
    pub fn from_config(plugins: &HashMap<String, serde_json::Value>) -> Option<Self> {
        let address = plugins
            .get("workspace")
            .and_then(|workspace| workspace.get("url"))
            .and_then(serde_json::Value::as_str)
            .filter(|address| !address.trim().is_empty())?;
        Some(
            Self::parse(address).unwrap_or_else(|error| {
                panic!("plugins.workspace.url in tauri.conf.json: {error}")
            }),
        )
    }

    /// A workspace address as a build names it, or as the app kept it: HTTPS, or plain HTTP on
    /// this machine or a private network for local development (the iOS Simulator reaches the
    /// computer as `localhost`, an Android emulator as `10.0.2.2`, a phone over Wi-Fi by the
    /// computer's own address).
    pub fn parse(address: &str) -> Result<Self, String> {
        let start = Url::parse(address).map_err(|error| format!("{address}: {error}"))?;
        match start.scheme() {
            "https" => Ok(Self { start }),
            "http" if is_development_host(&start) => Ok(Self { start }),
            _ => Err(format!(
                "{address}: the workspace must be served over HTTPS (HTTP only on localhost or a private network)"
            )),
        }
    }

    /// The address a person typed on the start page, as the workspace's origin: `HTTPS` when they
    /// named no scheme, and nothing after the host, so a link they pasted from a page of the
    /// workspace opens its start. Plain HTTP only when `development` (a debug build) and only on
    /// the addresses [`Workspace::parse`] allows it for: a release build reaches every workspace
    /// over HTTPS, as every Worker serves it.
    pub fn from_input(input: &str, development: bool) -> Result<Self, String> {
        let input = input.trim();
        if input.is_empty() {
            return Err("Enter your workspace's address.".to_owned());
        }
        let address = if input.contains("://") {
            input.to_owned()
        } else {
            format!("https://{input}")
        };
        let Ok(url) = Url::parse(&address) else {
            return Err(format!("“{input}” is not a web address."));
        };
        // A name on the internet (`workspace`, a word typed alone, is none), or in a debug build
        // a development address over HTTP.
        let named = matches!(url.host(), Some(Host::Domain(host)) if host.contains('.'));
        let development_address =
            development && url.scheme() == "http" && is_development_host(&url);
        if !named && !development_address {
            return Err(format!("“{input}” is not a web address."));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("Leave the user name and password out of the address.".to_owned());
        }
        match url.scheme() {
            "https" => {}
            "http" if development => {}
            "http" => {
                return Err(
                    "The workspace must be served over HTTPS. Start the address with https://."
                        .to_owned(),
                );
            }
            _ => return Err(format!("“{input}” is not a web address.")),
        }
        Self::parse(&format!("{}/", url.origin().ascii_serialization()))
            .map_err(|_| "The workspace must be served over HTTPS.".to_owned())
    }

    /// The page the app opens on launch.
    pub fn start(&self) -> &Url {
        &self.start
    }

    /// The workspace's origin, as a page's `location.origin` names it.
    pub fn origin(&self) -> String {
        self.start.origin().ascii_serialization()
    }

    /// Whether `url` is a page of the workspace: the same origin as its start page.
    pub fn owns(&self, url: &Url) -> bool {
        url.origin() == self.start.origin()
    }
}

/// Whether `url` is the app's own start page (src/index.html).
fn is_start_page(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" => url.host_str() == Some(START_PAGE_HOST),
        _ => false,
    }
}

/// Decides a navigation, in any frame: the web view reports a frame's navigations as it does the
/// page's, without telling them apart. So every web page stays in the web view, as it would in a
/// browser tab: Duo's prompt and Microsoft's sign-in, which come back to the workspace when they
/// finish, Stripe's frames, and a bank's page. A link on a workspace page to another site never
/// gets here: the web view's click script (`OUTWARD_LINKS` in window.rs) asks for a new window
/// instead, which [`new_window`] sends to the browser. It needs no workspace: which page is the
/// workspace's matters only to a new window.
pub fn navigation(url: &Url) -> Navigation {
    match url.scheme() {
        "http" | "https" | "about" | "blob" | "data" => Navigation::Stay,
        // The app's own start page (src/index.html).
        "tauri" if is_start_page(url) => Navigation::Stay,
        "mailto" | "tel" | "sms" | "facetime" => Navigation::System,
        _ => Navigation::Refuse,
    }
}

/// Decides a request for a new window. A workspace page, or the app's start page (a workspace's
/// sign-in page links it to change the workspace), opens in the app's one web view; every other
/// site opens in the browser, where the person has their passwords.
pub fn new_window(workspace: Option<&Workspace>, url: &Url) -> NewWindow {
    match url.scheme() {
        "http" | "https" if workspace.is_some_and(|workspace| workspace.owns(url)) => {
            NewWindow::Here
        }
        _ if is_start_page(url) => NewWindow::Here,
        "http" | "https" => NewWindow::Browser,
        "blob" => NewWindow::Here,
        "mailto" | "tel" | "sms" | "facetime" => NewWindow::System,
        _ => NewWindow::Refuse,
    }
}

/// Whether an HTTP address is one a development build may open: this machine, or a private
/// network address (RFC 1918), which the emulators and a phone on the computer's Wi-Fi reach it by.
fn is_development_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(host)) => host == "localhost" || host == START_PAGE_HOST,
        Some(Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE: &str = "https://workspace.example.com/";

    fn example() -> Workspace {
        Workspace::parse(EXAMPLE).unwrap()
    }

    fn url(address: &str) -> Url {
        Url::parse(address).unwrap()
    }

    #[test]
    fn a_workspace_is_https_or_development_http() {
        assert!(Workspace::parse(EXAMPLE).is_ok());
        assert!(Workspace::parse("http://localhost:5174").is_ok());
        assert!(Workspace::parse("http://127.0.0.1:5174").is_ok());
        assert!(Workspace::parse("http://10.0.2.2:5174").is_ok());
        assert!(Workspace::parse("http://192.168.1.20:5174").is_ok());
        assert!(Workspace::parse("http://[::1]:5174").is_ok());
        assert!(Workspace::parse("http://workspace.example.com/").is_err());
        assert!(Workspace::parse("http://8.8.8.8/").is_err());
        assert!(Workspace::parse("file:///workspace").is_err());
        assert!(Workspace::parse("not a url").is_err());
    }

    #[test]
    fn the_configuration_may_name_a_workspace_and_names_none_by_default() {
        assert_eq!(Workspace::from_config(&HashMap::new()), None);
        let empty = HashMap::from([("workspace".to_owned(), serde_json::json!({ "url": "" }))]);
        assert_eq!(Workspace::from_config(&empty), None);
        let local = HashMap::from([(
            "workspace".to_owned(),
            serde_json::json!({ "url": "http://localhost:5174" }),
        )]);
        assert_eq!(
            Workspace::from_config(&local).unwrap().start().as_str(),
            "http://localhost:5174/"
        );
    }

    #[test]
    #[should_panic(expected = "plugins.workspace.url")]
    fn a_configuration_naming_a_plain_http_site_is_a_broken_build() {
        let broken = HashMap::from([(
            "workspace".to_owned(),
            serde_json::json!({ "url": "http://workspace.example.com" }),
        )]);
        let _ = Workspace::from_config(&broken);
    }

    #[test]
    fn what_a_person_types_becomes_the_workspaces_origin_over_https() {
        for (input, expected) in [
            ("workspace.example.com", EXAMPLE),
            ("  workspace.example.com  ", EXAMPLE),
            ("https://workspace.example.com", EXAMPLE),
            (
                "https://workspace.example.com/mail?folder=inbox#top",
                EXAMPLE,
            ),
            ("HTTPS://Workspace.Example.COM/", EXAMPLE),
            (
                "workspace.example.com:8443/drive",
                "https://workspace.example.com:8443/",
            ),
            ("mail.team.workers.dev", "https://mail.team.workers.dev/"),
        ] {
            assert_eq!(
                Workspace::from_input(input, false).map(|workspace| workspace.start().to_string()),
                Ok(expected.to_owned()),
                "{input}"
            );
        }
    }

    #[test]
    fn a_release_build_refuses_what_is_no_https_workspace() {
        for input in [
            "",
            "   ",
            "http://workspace.example.com",
            "http://localhost:5174",
            "localhost:5174",
            "workspace",
            "ftp://workspace.example.com",
            "https://admin:secret@workspace.example.com",
            "not a url",
        ] {
            assert!(Workspace::from_input(input, false).is_err(), "{input}");
        }
    }

    #[test]
    fn a_debug_build_also_takes_a_development_workspace_over_http() {
        assert_eq!(
            Workspace::from_input("http://10.0.2.2:5174/mail", true)
                .unwrap()
                .start()
                .as_str(),
            "http://10.0.2.2:5174/"
        );
        assert!(Workspace::from_input("http://localhost:5174", true).is_ok());
        assert!(Workspace::from_input("http://workspace.example.com", true).is_err());
        assert!(Workspace::from_input("http://8.8.8.8", true).is_err());
    }

    #[test]
    fn workspace_pages_and_framed_sites_stay_in_the_web_view() {
        for address in [
            "https://workspace.example.com/mail",
            "https://workspace.example.com/login?next=%2Fdrive",
            "https://api-1234abcd.duosecurity.com/oauth/v1/authorize",
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            "https://verify.stripe.com/start/test",
            "about:blank",
            "about:srcdoc",
            "blob:https://workspace.example.com/4b1e",
            "tauri://localhost/index.html",
            "tauri://localhost/index.html?change",
            "http://tauri.localhost/index.html",
        ] {
            assert_eq!(navigation(&url(address)), Navigation::Stay, "{address}");
        }
    }

    #[test]
    fn mail_and_phone_links_go_to_the_system_and_other_schemes_nowhere() {
        for address in [
            "mailto:someone@example.com?subject=Hi",
            "tel:+31201234567",
            "sms:+31201234567",
            "facetime:+31201234567",
        ] {
            assert_eq!(navigation(&url(address)), Navigation::System, "{address}");
        }
        for address in [
            "file:///etc/passwd",
            "tauri://evil.example/",
            "x-custom://open",
            "javascript:alert(1)",
        ] {
            assert_eq!(navigation(&url(address)), Navigation::Refuse, "{address}");
        }
    }

    #[test]
    fn a_new_window_on_a_workspace_page_opens_in_the_web_view_and_elsewhere_in_the_browser() {
        let workspace = Some(example());
        let workspace = workspace.as_ref();
        assert_eq!(
            new_window(
                workspace,
                &url("https://workspace.example.com/api/drive/files/n1?download=1")
            ),
            NewWindow::Here
        );
        assert_eq!(
            new_window(workspace, &url("blob:https://workspace.example.com/4b1e")),
            NewWindow::Here
        );
        assert_eq!(
            new_window(
                workspace,
                &url("https://github.com/rivi-software/workspace/issues/1")
            ),
            NewWindow::Browser
        );
        assert_eq!(
            new_window(workspace, &url("mailto:someone@example.com")),
            NewWindow::System
        );
        assert_eq!(
            new_window(workspace, &url("file:///tmp/x")),
            NewWindow::Refuse
        );
    }

    #[test]
    fn the_start_page_opens_in_the_web_view_and_without_a_workspace_every_site_in_the_browser() {
        for address in [
            "tauri://localhost/index.html?change",
            "http://tauri.localhost/index.html?change",
        ] {
            assert_eq!(
                new_window(Some(&example()), &url(address)),
                NewWindow::Here,
                "{address}"
            );
            assert_eq!(
                new_window(None, &url(address)),
                NewWindow::Here,
                "{address}"
            );
        }
        assert_eq!(
            new_window(None, &url("https://workspace.example.com/mail")),
            NewWindow::Browser
        );
    }

    #[test]
    fn a_development_workspace_on_the_android_emulators_address_owns_its_pages() {
        let workspace = Workspace::parse("http://10.0.2.2:5174").unwrap();
        assert!(workspace.owns(&url("http://10.0.2.2:5174/mail")));
        assert!(!workspace.owns(&url("http://localhost:5174/mail")));
        assert_eq!(workspace.origin(), "http://10.0.2.2:5174");
    }
}
