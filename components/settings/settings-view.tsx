"use client";
/**
 * THE SETTINGS PAGE (mobile wave, 2026-10-30): the settings dialog became
 * a route again — /settings/<section> — with its own sidebar of sections
 * in place of the sessions sidebar. A centered 920px modal could not fit a
 * phone; a page can.
 *
 * - Desktop: section sidebar (the session-list mono language, active =
 *   bg-accent) + one scrolling content column. /settings lands on Providers.
 * - Phone (< md): /settings is the section LIST alone; a section is its
 *   own screen with a back row to the list (the native settings pattern).
 * - ✕ and Esc return to the page settings was opened from.
 * - The sections still talk to /api/settings* and localStorage only.
 *
 * The record + the single `write` seam live here: one record instance for
 * the whole page, sections write through it, switching sections never
 * refetches (the view stays mounted across /settings/* navigations).
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { ChevronLeftIcon } from "lucide-react";
import {
	CURRENT_SETTINGS_VERSION,
	type AgentSettings,
	type AppearanceSettings,
	type CompactionSettings,
	type GraphSettings,
	type UserSettings,
} from "@/src/core";
import { useAppearance } from "./appearance.tsx";
import { SettingsSection } from "./controls.tsx";
import { UpdateSettings } from "./update-settings.tsx";
import { AgentSection } from "./agent-section.tsx";
import type { ModelsSettings } from "@/src/core";
import { MENU_CLOSE_EVENT, MENU_OPEN_EVENT } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { KeysSection } from "./keys-section.tsx";
import { Hint } from "@/components/ui/hint";
import { AppearanceSection, GraphSection } from "./appearance-section.tsx";
import { KeyboardSection } from "./keyboard-section.tsx";
import { ChatGPTUIProvider } from "./chatgpt-connection.tsx";
import { NativeSubscriptionUIProvider } from "./subscription-connections.tsx";

/** Owner (2026-09-20): hints earn their place — mechanics-explaining
 *  prose is out; only the keyboard note stays (storage location is a
 *  real question users ask). */
const SECTIONS = [
	{ id: "keys", label: "Providers" },
	{ id: "agent", label: "Agent" },
	{ id: "appearance", label: "Appearance" },
	{ id: "graph", label: "Graph" },
	{ id: "keyboard", label: "Keyboard", hint: "Stored on this device" },
	{ id: "general", label: "General" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

export function isSectionId(id: string | undefined): id is SectionId {
	return SECTIONS.some((s) => s.id === id);
}

/** /settings, /settings/<section>, plus ?row= for the keys deep link. */
export function settingsHref(section?: SectionId, row?: string | null): string {
	const base = section ? `/settings/${section}` : "/settings";
	return row ? `${base}?row=${encodeURIComponent(row)}` : base;
}

/** Where ✕/Esc return to — the page settings was opened from. Session
 *  storage: it survives the section-to-section navigations and a reload. */
const RETURN_KEY = "lh:settings-return";

export function settingsReturnPath(): string {
	try {
		return sessionStorage.getItem(RETURN_KEY) ?? "/";
	} catch {
		return "/";
	}
}

/** `open(section?, row?)` — the optional ROW deep-links into the Keys
 *  section with that row unfolded (zero-keys wave: the dictation error's
 *  click lands on the Deepgram row). `row` is the KEY ID (the env-var
 *  name, e.g. DEEPGRAM_API_KEY — KeysSection's openRow state), not the
 *  row's testid. */
const SettingsContext = createContext<{ open: (section?: string, row?: string) => void }>({ open: () => {} });

/** AppShell-level mount: the sidebar row, the mod+, chord and the Electron
 *  menu call `open`, which navigates to the settings route. `navigate` is
 *  the router seam (AppShell passes router.push; routerless mounts — the
 *  tests — fall back to a plain location change). */
export function SettingsProvider({
	children,
	navigate,
}: {
	children: React.ReactNode;
	navigate?: (href: string) => void;
}) {
	const open = useCallback(
		(section?: string, row?: string) => {
			const here = window.location ? window.location.pathname + window.location.search : "/";
			if (!here.startsWith("/settings")) {
				try {
					sessionStorage.setItem(RETURN_KEY, here);
				} catch {
					/* storage blocked: close falls back to home */
				}
			}
			// No section = bare /settings: Providers on desktop, the list on a phone.
			const href = settingsHref(isSectionId(section) ? section : undefined, row);
			if (navigate) navigate(href);
			else window.location.assign(href);
		},
		[navigate],
	);
	useEffect(() => window.lh?.onOpenSettings?.((section) => open(section)), [open]);
	return (
		<ChatGPTUIProvider><NativeSubscriptionUIProvider><SettingsContext.Provider value={{ open }}>
			{children}
		</SettingsContext.Provider></NativeSubscriptionUIProvider></ChatGPTUIProvider>
	);
}

export function useSettings() {
	return useContext(SettingsContext);
}

/** The whole settings page, router-free (the route wires `onSelect` and
 *  `onClose` to navigation) so it renders under SSR and jsdom tests.
 *  `section` undefined = the bare /settings: Providers on desktop, the
 *  section list alone on a phone. `onSelect(undefined)` = back to it. */
export function SettingsView({
	section,
	onSelect,
	onClose,
	initialRow = null,
}: {
	section?: SectionId;
	onSelect: (section: SectionId | undefined) => void;
	onClose: () => void;
	/** The keys row to unfold on arrival (null = none). */
	initialRow?: string | null;
}) {
	const { onAppearanceChange } = useAppearance();
	const [record, setRecord] = useState<UserSettings | null | undefined>(
		undefined,
	);
	const [error, setError] = useState<string | null>(null);
	// MenuShell open-count — drives the content column's scroll lock.
	const [openMenus, setOpenMenus] = useState(0);
	const contentRef = useRef<HTMLDivElement | null>(null);
	// Scroll-lock (fix wave, owner ruling: the scrollbar MAY stay,
	// scrolling must NOT happen, nothing may move): the content column
	// keeps overflow-y-auto — the scrollbar and every width stay exactly
	// as they are — and while any MenuShell is open, non-passive wheel +
	// touchmove listeners on the column preventDefault. React attaches
	// synthetic wheel/touch passively at the root, so this needs the
	// native-listener ref seam.
	useEffect(() => {
		const el = contentRef.current;
		if (!el || openMenus === 0) return;
		const block = (e: Event) => e.preventDefault();
		el.addEventListener("wheel", block, { passive: false });
		el.addEventListener("touchmove", block, { passive: false });
		return () => {
			el.removeEventListener("wheel", block);
			el.removeEventListener("touchmove", block);
		};
	}, [openMenus]);

	useEffect(() => {
		const onOpen = () => setOpenMenus((n) => n + 1);
		const onClose = () => setOpenMenus((n) => Math.max(0, n - 1));
		window.addEventListener(MENU_OPEN_EVENT, onOpen);
		window.addEventListener(MENU_CLOSE_EVENT, onClose);
		return () => {
			window.removeEventListener(MENU_OPEN_EVENT, onOpen);
			window.removeEventListener(MENU_CLOSE_EVENT, onClose);
		};
	}, []);
	const active: SectionId = section ?? "keys";
	const activeLabel = SECTIONS.find((s) => s.id === active)!.label;

	// Fetch once per page mount. 200 {settings: null} is FIRST BOOT
	// (no record = factory everything), not a failure — the error state is
	// a non-200 or a network throw only.
	useEffect(() => {
		fetch("/api/settings")
			.then((r) =>
				r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)),
			)
			.then((body: { settings: UserSettings | null }) =>
				setRecord(body.settings ?? { version: CURRENT_SETTINGS_VERSION }),
			)
			.catch(() => setRecord(null));
	}, []);

	// Escape closes — the layered-dismiss convention (Esc is dead for the
	// sections' own editors while they hold focus; this listener is the
	// page's outer layer).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// THE ONE-ESC LAW (owner, keyboard round 2026-10-06): claim
				// at the document level — the window chain (dictation →
				// abort) must not also act. One Esc, one action.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	/** ONE writer for the whole page: PUT the whole section, keep the
	 *  record mirror in sync, surface route errors inline (a 400 is a
	 *  schema mistake caught by the validation surface). */
	const write = useCallback(
		async (
			section: "general" | "agent" | "models" | "appearance" | "graph" | "compaction",
			body: object,
		) => {
			setError(null);
			const res = await fetch(`/api/settings/${section}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				setError(`${section}: ${detail.error ?? res.status}`);
				return;
			}
			// Server truth, never the request body (fix wave, owner repro):
			// the models section clamps pinned thinking levels on write
			// (bd68486) — a swap that rides an unsupported level lands
			// CLAMPED in the record, and the writing surface must show the
			// stored value in this same interaction, not the optimistic one.
			const stored = (
				(await res.json().catch(() => null)) as { settings?: UserSettings } | null
			)?.settings;
			setRecord(
				(prev) =>
					stored ?? ({ ...(prev ?? {}), [section]: body }) as UserSettings,
			);
			notifySettingsSaved(section);
			if (section === "appearance")
				onAppearanceChange(body as AppearanceSettings);
		},
		[onAppearanceChange],
	);

	const closeButton = (
		<Hint label="Close" binding="escape" side="left">
			<button
				type="button"
				aria-label="Close settings"
				data-testid="settings-close"
				className="lh-no-drag ml-auto size-9 shrink-0 rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				onClick={onClose}
			>
				<svg
					viewBox="0 0 16 16"
					className="mx-auto size-3.5"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
				>
					<path d="M4 4l8 8M12 4l-8 8" />
				</svg>
			</button>
		</Hint>
	);

	return (
		<div data-testid="settings-page" className="flex h-dvh w-full min-w-0">
			{/* Section sidebar — the sessions sidebar's geometry and mono
			    language. On a phone it IS the /settings screen and hides
			    once a section is open. */}
			<aside
				className={`w-full shrink-0 flex-col border-border bg-background md:flex md:w-60 md:border-r ${
					section ? "hidden" : "flex"
				}`}
			>
				<header className="lh-drag lh-lights-gutter flex h-15 shrink-0 items-center gap-3 px-4">
					<h1 className="font-title text-2xl tracking-tight">Settings</h1>
					{closeButton}
				</header>
				<nav
					aria-label="Settings sections"
					data-testid="settings-nav"
					className="flex flex-col gap-1 p-2"
				>
					{SECTIONS.map((s) => (
						<button
							key={s.id}
							type="button"
							data-testid={`settings-nav-${s.id}`}
							aria-current={active === s.id}
							// The active fill is desktop-only: on a phone the list is
							// a menu of doors, nothing is "open" while it shows.
							className={`rounded-sm px-3 py-2.5 text-left font-ui text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:py-1.5 ${
								active === s.id ? "md:bg-accent md:text-foreground" : ""
							}`}
							onClick={() => onSelect(s.id)}
						>
							{s.label}
						</button>
					))}
				</nav>
			</aside>

			{/* Content column — one section at a time, this scrolls — and
			    LOCKS while any MenuShell is open (owner ruling: no scrolling
			    with a dropdown down; MenuShell announces open/close, the
			    count keeps overlap honest). On a phone it shows only with a
			    section open, under a back row to the list. */}
			<main className={`min-w-0 flex-1 flex-col md:flex ${section ? "flex" : "hidden"}`}>
				<header className="flex h-15 shrink-0 items-center gap-1 border-b border-border px-2 md:hidden">
					<button
						type="button"
						data-testid="settings-back"
						onClick={() => onSelect(undefined)}
						className="flex items-center gap-1 rounded-sm px-2 py-2 font-ui text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<ChevronLeftIcon className="size-4" />
						Settings
					</button>
					<span className="font-ui text-sm">{activeLabel}</span>
					{closeButton}
				</header>
				<div
					ref={contentRef}
					className="min-h-0 flex-1 overflow-y-auto md:pt-4"
					data-testid="settings-content"
				>
					<div className="mx-auto w-full max-w-3xl">
						{error && (
							<p
								role="alert"
								className="m-4 rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500"
								data-testid="settings-error"
							>
								{error}
							</p>
						)}
						{record === undefined ? (
							<p className="px-6 py-5 text-xs text-muted-foreground/70">
								Loading settings…
							</p>
						) : record === null ? (
							<p className="px-6 py-5 text-xs text-muted-foreground/70">
								Settings could not be loaded — refresh to retry.
							</p>
						) : (
							<div>
								{active === "general" && (
									<SettingsSection
										title="General"
										testid="section-general"
									>
										<UpdateSettings
											autoUpdate={record.general?.autoUpdate ?? true}
											onAutoUpdateChange={(on) =>
												void write("general", { ...record.general, autoUpdate: on })
											}
										/>
									</SettingsSection>
								)}
								{active === "keys" && (
									<SettingsSection title="Providers" testid="section-keys">
										<KeysSection initialRow={initialRow ?? undefined} />
									</SettingsSection>
								)}
								{active === "agent" && (
									<SettingsSection
										title="Agent"
										testid="section-agent"
									>
										<AgentSection
											agent={record.agent}
											models={record.models}
											graph={record.graph}
											compaction={record.compaction}
											onModelsChange={(next: ModelsSettings) =>
												void write("models", next)
											}
											onSectionChange={(next: AgentSettings) =>
												void write("agent", next)
											}
											onCompactionChange={(next: CompactionSettings) =>
												void write("compaction", next)
											}
										/>
									</SettingsSection>
								)}
								{active === "appearance" && (
									<SettingsSection
										title="Appearance"
										testid="section-appearance"
									>
										<AppearanceSection
											appearance={record.appearance}
											onSectionChange={(next: AppearanceSettings) =>
												void write("appearance", next)
											}
										/>
									</SettingsSection>
								)}
								{active === "graph" && (
									<SettingsSection
										title="Graph"
										testid="section-graph"
									>
										<GraphSection
											graph={record.graph}
											onSectionChange={(next: GraphSettings) =>
												void write("graph", next)
											}
										/>
									</SettingsSection>
								)}
								{active === "keyboard" && (
									<SettingsSection
										title="Keyboard"
										hint="Stored on this device"
										testid="section-keyboard"
									>
										<KeyboardSection />
									</SettingsSection>
								)}
							</div>
						)}
					</div>
				</div>
			</main>
		</div>
	);
}
