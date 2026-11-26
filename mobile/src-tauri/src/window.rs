//! The app's one web view: the start page (src/index.html), then the workspace, with the rules
//! for where it may go, what opens elsewhere, and where a download lands.

#[cfg(any(target_os = "ios", test))]
use std::path::{Path, PathBuf};

#[cfg(target_os = "ios")]
use tauri::webview::DownloadEvent;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::endpoint::Endpoint;
use crate::workspace::{self, Navigation, NewWindow, Workspace};

/// The web view's label.
pub const MAIN: &str = "main";

const TITLE: &str = "RIVI Workspace";

/// Opens the web view on the start page (src/index.html), which asks for the workspace's address
/// when the app has none (endpoint.rs), goes on to the workspace, and says so when the workspace
/// cannot be reached. Every decision reads the workspace anew: the person may name another on the
/// start page while the app runs.
pub fn open_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let navigating = app.clone();
    let opening = app.clone();

    // The app's version for its user agent; Android adds it in MainActivity.kt.
    #[cfg(any(desktop, target_os = "ios"))]
    let version = app.package_info().version.to_string();
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title(TITLE)
        .on_navigation(move |url| match workspace::navigation(url) {
            Navigation::Stay => true,
            Navigation::System => {
                let _ = navigating.opener().open_url(url.as_str(), None::<&str>);
                false
            }
            Navigation::Refuse => false,
        })
        // The click script for links to other sites, on each page of the workspace once it has
        // loaded. Not an initialization script: those are fixed when the web view is made, before
        // the person may have named their workspace on the start page.
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let current = webview.app_handle().state::<Endpoint>().current();
            if let Some(workspace) = current
                && workspace.owns(payload.url())
            {
                let _ = webview.eval(outward_links_script(&workspace));
            }
        })
        .on_new_window(move |url, _features| {
            let app = &opening;
            let current = app.state::<Endpoint>().current();
            match workspace::new_window(current.as_ref(), &url) {
                NewWindow::Here => {
                    // Once the web view has heard that no window opens: a navigation started from
                    // inside its own delegate would race that answer.
                    if let Some(main) = app.get_webview_window(MAIN) {
                        let _ = app.run_on_main_thread(move || {
                            let _ = main.navigate(url);
                        });
                    }
                }
                NewWindow::Browser | NewWindow::System => {
                    let _ = app.opener().open_url(url.as_str(), None::<&str>);
                }
                NewWindow::Refuse => {}
            }
            NewWindowResponse::Deny
        });
    // A phone's shape for the window `tauri dev` opens on a Mac, and the Mac's agent with the app
    // added; the phones add it to their web view's own agent instead.
    #[cfg(desktop)]
    let builder = builder
        .inner_size(390.0, 844.0)
        .min_inner_size(320.0, 480.0)
        .user_agent(&with_app(BROWSER, &version));
    // On an iPhone a download lands in the app's Documents folder, which the Files app shows under
    // On My iPhone › RIVI Workspace (gen/apple/Info.plist, `UIFileSharingEnabled`). Left to WebKit
    // it would go to a Downloads folder the app's sandbox does not have.
    #[cfg(target_os = "ios")]
    let builder = builder.on_download(|webview, event| {
        if let DownloadEvent::Requested { destination, .. } = event
            && let Ok(documents) = webview.path().document_dir()
        {
            *destination = free_destination(&documents, destination.as_path());
        }
        true
    });
    let window = builder.build()?;
    #[cfg(target_os = "ios")]
    webkit::make_native(&window, version);
    Ok(window)
}

/// `suggested`'s file name in `folder`, numbered when a file of that name is there already, as
/// WebKit numbers them in its own folder: `report (1).pdf`.
#[cfg(any(target_os = "ios", test))]
fn free_destination(folder: &Path, suggested: &Path) -> PathBuf {
    let name = suggested
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    let mut path = folder.join(name);
    let mut counter = 1;
    while path.exists() {
        path = folder.join(format!("{stem} ({counter}){extension}"));
        counter += 1;
    }
    path
}

/// The app's name and version after a user agent, so the workspace can tell
/// the app from the browser (`app/lib/mobile-app.ts` reads the token). On an iPhone
/// and on Android it follows the web view's own agent (`webkit::make_native`, MainActivity.kt),
/// which names the real system and browser version: Drive's signing evidence and Duo's and
/// Microsoft's sign-in read it.
#[cfg(any(desktop, target_os = "ios", test))]
fn with_app(agent: &str, version: &str) -> String {
    format!("{agent} RIVIWorkspaceApp/{version}")
}

/// WebKit on the Mac as the window `tauri dev` opens there reports itself.
#[cfg(desktop)]
const BROWSER: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/// On a workspace page, a tap on a link to another site asks for a new window instead, which
/// `on_new_window` sends to the browser. Left to `on_navigation`, the link would replace the
/// workspace: the web view reports a frame's navigations as it does the page's, so another site
/// has to stay in the web view (`Workspace::navigation`). Only a tap the page left alone on a link
/// that would load in this web view counts; a link being edited follows nothing, as in a browser.
const OUTWARD_LINKS: &str = r#"
if (location.origin === workspace && !window.__workspaceOutwardLinks) {
  window.__workspaceOutwardLinks = true;
  window.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    const link = event
      .composedPath()
      .find((node) => node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement);
    if (!link || !link.hasAttribute("href") || link.hasAttribute("download")) return;
    if (link.isContentEditable) return;
    if (!["", "_self", "_parent", "_top"].includes(link.target.toLowerCase())) return;
    let url;
    try {
      url = new URL(link.href);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (url.origin === workspace) return;
    // The app's own start page on Android, which the sign-in page links to change the workspace.
    if (url.hostname === "tauri.localhost") return;
    event.preventDefault();
    window.open(url.href, "_blank", "noopener");
  });
}
"#;

/// [`OUTWARD_LINKS`] for the workspace the app opens. It runs in the main frame only (a web view's
/// `eval` does), so a frame's links behave as they would in a browser tab, and once a page: the
/// workspace is one page that changes its address itself, and a page that loads again starts
/// without the listener.
fn outward_links_script(workspace: &Workspace) -> String {
    format!(
        "{{\nconst workspace = {};{OUTWARD_LINKS}}}",
        serde_json::Value::from(workspace.origin())
    )
}

#[cfg(target_os = "ios")]
mod webkit {
    //! What WebKit on an iPhone does for Safari and not for a WKWebView, asked of the web view
    //! itself: the edge swipe back and forward (wry turns it on for the Mac alone), the page
    //! under the status bar, as a native screen is (WebKit would inset the page below the status
    //! bar and paint the band in the system's colour; under the bar, the page keeps clear of it
    //! by its own safe-area insets, `viewport-fit=cover` in the workspace), and the app's name
    //! after the web view's own user agent.
    #![allow(unsafe_code)]

    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSString;
    use tauri::{Runtime, WebviewWindow};

    use super::with_app;

    /// `UIScrollViewContentInsetAdjustmentNever`.
    const INSET_ADJUSTMENT_NEVER: isize = 2;

    /// What WebKit reports for an iPhone when the web view keeps its agent to itself.
    const IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

    pub fn make_native<R: Runtime>(window: &WebviewWindow<R>, version: String) {
        let _ = window.with_webview(move |webview| {
            // SAFETY: on iOS `inner` is the WKWebView wry built for this window, alive for as
            // long as the window is; the messages are property setters on it and on the scroll
            // view it owns, and a key-value read of its user agent, a string it keeps.
            unsafe {
                let wk: *mut AnyObject = webview.inner().cast();
                let _: () = msg_send![wk, setAllowsBackForwardNavigationGestures: true];
                let scroll_view: *mut AnyObject = msg_send![wk, scrollView];
                let _: () =
                    msg_send![scroll_view, setContentInsetAdjustmentBehavior: INSET_ADJUSTMENT_NEVER];
                let key = NSString::from_str("userAgent");
                let own: Option<Retained<NSString>> = msg_send![wk, valueForKey: &*key];
                let agent = own.map_or_else(|| IPHONE.to_owned(), |own| own.to_string());
                let custom = NSString::from_str(&with_app(&agent, &version));
                let _: () = msg_send![wk, setCustomUserAgent: &*custom];
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outward_links_know_the_workspaces_origin_alone() {
        let workspace = Workspace::parse("https://workspace.example.com/").unwrap();
        let script = outward_links_script(&workspace);
        assert!(script.starts_with(
            "{\nconst workspace = \"https://workspace.example.com\";\nif (location.origin === workspace && !window.__workspaceOutwardLinks) {"
        ));
        assert!(script.ends_with("}\n}"));

        let local = Workspace::parse("http://localhost:5174/").unwrap();
        assert!(
            outward_links_script(&local)
                .starts_with("{\nconst workspace = \"http://localhost:5174\";")
        );
    }

    #[test]
    fn the_agent_names_the_app_after_the_browsers_own() {
        assert_eq!(
            with_app(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
                "1.2.3"
            ),
            "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 RIVIWorkspaceApp/1.2.3"
        );
    }

    #[test]
    fn a_download_takes_a_free_name_in_its_folder() {
        let folder =
            std::env::temp_dir().join(format!("workspace-mobile-downloads-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let suggested = Path::new("/nowhere/Downloads/report.pdf");
        assert_eq!(
            free_destination(&folder, suggested),
            folder.join("report.pdf")
        );
        std::fs::write(folder.join("report.pdf"), b"").unwrap();
        assert_eq!(
            free_destination(&folder, suggested),
            folder.join("report (1).pdf")
        );
        std::fs::write(folder.join("report (1).pdf"), b"").unwrap();
        assert_eq!(
            free_destination(&folder, suggested),
            folder.join("report (2).pdf")
        );
        assert_eq!(
            free_destination(&folder, Path::new("notes")),
            folder.join("notes")
        );
        assert_eq!(
            free_destination(&folder, Path::new(".env")),
            folder.join(".env")
        );
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
