# DeepSeek Gestalt

Desktop product that wraps the DeepSeek Harness browser surface in an Electron window and ships as a versioned installable.

## Language

**DeepSeek Gestalt**:
The named desktop product. Dock, installer, and About use this spelling. The first Desktop Bundle is `0.1.0`. The macOS/Windows app id is `com.gestalt.deepseek`. It is not a rename of the CLI, and it is not 千机·Gestalt. The Desktop Session Surface keeps the deepseek wordmark and replaces the HARNESS badge with GESTALT; browser `dsh web` keeps HARNESS.
_Avoid_: DeepSeek Harness Desktop, Gestalt (unqualified), dsh desktop, deepseek GESTALT (as the product name)

**Desktop Host**:
The Electron process that owns the window, application menu, process lifetime, and update checks.
_Avoid_: Electron app, main process (as the product name)

**Web Host**:
The bundled `dsh web` process that serves the existing browser UI and injects `window.__DSH_BOOT__`.
_Avoid_: Vite app, frontend server, renderer backend

**Desktop Bundle**:
One semvered installable that contains a Desktop Host and a locked Web Host snapshot.
_Avoid_: dsh version (the npm line), release asset (a file inside a bundle)

**Harness Engine**:
The existing `dsh` profile runtime and packages that the Web Host boots. DeepSeek Gestalt does not reimplement it.
_Avoid_: backend (Gestalt's word for a different process), kernel

**Update Control**:
The in-page control on the same sidebar-foot row as Settings, to the right of the gear, that drives Desktop Host update phases. It is not a Settings panel page and is not present in the browser-only web profile.
_Avoid_: updater window, settings section (for this control)

**Mobile Pairing Settings**:
The Desktop-only `手机配对` Settings section that presents Platform Account state, Mobile Access enablement, Pairing Challenges, authentication words, confirmation, and paired devices. Desktop Host owns system-browser authorization, protected installation keys, current-Installation proofs, and the Remote Access controller; the Web Host renders only bridge-projected state. Development can select the keyless controller proof explicitly, while production remains unavailable until its handshake provider passes independent review. The normal sidebar and Session Surface have no Account or pairing status.
_Avoid_: Account Control, GitHub sidebar button, pairing window

**Personal Release Channel**:
The first public GitHub Releases feed, hosted on the current origin fork rather than `deepseek-ai/deepseek-harness`.
_Avoid_: official DeepSeek release, upstream release

**Window Chrome**:
The Desktop Host frame: no system title bar; macOS traffic lights sit over a Desktop-only drag strip above the existing sidebar header. Windows paints its own caption buttons. It is not the Settings panel and not the Update Control.
_Avoid_: title bar (unless distinguishing the macOS system bar), caption

**Session Surface**:
The existing dsh web page: one window lists every Workspace and Session in the sidebar. A Workspace is not a window. Desktop does not replace Host features such as the native directory picker.
_Avoid_: workspace window, one workspace per window

**Launch Directory**:
The Web Host process cwd when started from the Dock or Start Menu: `~/Library/Application Support/DeepSeek Gestalt/defaultWorkspace` on macOS, `%APPDATA%\\DeepSeek Gestalt\\defaultWorkspace` on Windows. Desktop Host creates the empty directory if needed. It is not a Workspace unless the user later adopts that path.
_Avoid_: launch-cwd, home, install directory, 未选择项目

**Offer card**:
A Desktop-only Settings card that can appear while its plugin is not installed. Enablement downloads a built bundle and a platform runtime pack into `$DSH_HOME`; it does not add that plugin to the Desktop Bundle extraResources.
_Avoid_: plugin marketplace, Docker sidecar (as the Desktop default)

**Sub2API sidecar**:
The local Sub2API process supervised by the out-of-tree `dsh-sub2api-sidecar` plugin. Account-pool and Composite routing stay in that process. Host UI uses an `admin-` key on `/api/v1/admin/*`; Composite inference uses an `sk-` key on `/v1/*`.
_Avoid_: embedding Sub2API, one token for admin and inference
