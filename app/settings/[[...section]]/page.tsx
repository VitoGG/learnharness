"use client";
import { notFound, useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";
import {
	SettingsView,
	isSectionId,
	settingsHref,
	settingsReturnPath,
	type SectionId,
} from "@/components/settings/settings-view.tsx";

/**
 * /settings and /settings/<section> (mobile wave, 2026-10-30 — the dialog
 * graduated back into a route). One optional catch-all so the view stays
 * mounted while switching sections: the record is fetched once. AppShell
 * hides the sessions sidebar here; this page brings its own.
 */
export default function SettingsPage() {
	// useSearchParams needs a Suspense boundary to keep /settings prerenderable.
	return (
		<Suspense>
			<SettingsRoute />
		</Suspense>
	);
}

function SettingsRoute() {
	const router = useRouter();
	const { section: segments } = useParams<{ section?: string[] }>();
	const row = useSearchParams().get("row");
	const section = segments?.[0];
	if ((segments?.length ?? 0) > 1 || (section !== undefined && !isSectionId(section))) notFound();

	const onSelect = useCallback(
		(next: SectionId | undefined) => router.push(settingsHref(next)),
		[router],
	);
	const onClose = useCallback(() => router.push(settingsReturnPath()), [router]);

	return (
		<SettingsView
			section={section as SectionId | undefined}
			onSelect={onSelect}
			onClose={onClose}
			initialRow={row}
		/>
	);
}
