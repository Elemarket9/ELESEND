# Ghana routing and ETA evidence

Audit date: 2026-11-08. Base: main @ 612b44101b6581e4a1d2774eca067658462178e8. Working branch: audit/2026-11-08-independent-verification. Verification must be based on GitHub Actions at this branch head, not on a green main. No physical Android device, Ghana routing engine, live PSP, production workload or disaster recovery environment was accessed in this review.

Repository paths include `services/api/eta/`, `services/api/infrastructure/maps/`, private MapLibre sources and Android map setup. In the custody regression suite the routing provider is explicitly synthetic, using coordinate delta / 8 seconds; that is *test-only fake routing*, not a verified road ETA. No Ghana routing runtime, OSRM graph, Photon service, road restrictions or physical recorded trips were used during this audit.

Required reproducible tests: source-grounded coordinates for Accra, Kasoa, Kumasi, Cape Coast, Winneba, Sunyani and surrounding communities; motorcycle routing and one-way restrictions; road snapping; inaccessible endpoints; tile/voice navigation; rerouting; offline and low bandwidth; map service independence. Compare timestamps and routes against actual GPS traces, never claim straight-line synthetic data is road ground truth. Status: not verified.
