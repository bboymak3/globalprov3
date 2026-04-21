/**
 * =============================================================
 * SISTEMA DE FIDELIZACION - GLOBAL PRO AUTOMOTRIZ
 * Worker: Recordatorios de Revision Tecnica via WhatsApp
 * =============================================================
 * 
 * Endpoints:
 *   POST /api/save-lead      - Guardar nuevo lead (patente + telefono)
 *   POST /api/unsubscribe     - Darse de baja de recordatorios
 *   GET  /api/check           - Consultar mes de revision por patente
 *   GET  /api/trigger?secret=X - Forzar envio manual (testing)
 * 
 * Cron: Todos los dias a las 09:00 Chile (UTC 13:00)
 * =============================================================
 */

interface Env {
	DB: D1Database;
	ULTRAMSG_INSTANCE: string;
	ULTRAMSG_TOKEN: string;
	CRON_SECRET: string;
}

interface LeadRecord {
	id: number;
	telefono: string;
	patente: string;
	ultimo_caracter: string;
	mes_revision: number;
	es_manual: number;
	fecha_registro: string;
	ultimo_aviso_enviado: string;
	activo: number;
}

// =============================================================
// CONSTANTES
// =============================================================

// Mapeo ultimo digito patente chilena -> mes de revision
const MESES_REVISION: Record<string, number> = {
	"1": 4,   // 1 -> Abril
	"2": 5,   // 2 -> Mayo
	"3": 6,   // 3 -> Junio
	"4": 7,   // 4 -> Julio
	"5": 8,   // 5 -> Agosto
	"6": 9,   // 6 -> Septiembre
	"7": 10,  // 7 -> Octubre
	"8": 11,  // 8 -> Noviembre
	"9": 1,   // 9 -> Enero
	"0": 2,   // 0 -> Febrero
};

const MESES_NOMBRES: string[] = [
	"", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
	"Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

// CORS headers para permitir llamadas desde mecanico247.com
const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

// =============================================================
// HELPERS
// =============================================================

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

function corsResponse(body: BodyInit, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	for (const [k, v] of Object.entries(CORS_HEADERS)) {
		headers.set(k, v);
	}
	return new Response(body, { ...init, headers });
}

function calcularMesRevision(ultimoChar: string): number | null {
	const c = ultimoChar.toUpperCase().trim();
	return MESES_REVISION[c] ?? null;
}

function sanitizarTelefono(tel: string): string {
	const clean = tel.replace(/[\s\-\+\(\)\.]/g, "");
	return clean.startsWith("56") ? clean : "56" + clean;
}

function sanitizarPatente(pat: string): string {
	return pat.toUpperCase().replace(/[\s\.\-·\-]/g, "");
}

// =============================================================
// ULTRAMSG - ENVIO DE WHATSAPP
// =============================================================

async function sendWhatsApp(
	telefono: string,
	mensaje: string,
	env: Env,
): Promise<{ success: boolean; error?: string }> {
	try {
		const phone = sanitizarTelefono(telefono);

		if (phone.length < 11) {
			return { success: false, error: "Telefono invalido" };
		}

		const params = new URLSearchParams({
			token: env.ULTRAMSG_TOKEN,
			to: phone,
			body: mensaje,
			priority: "10",
		});

		const response = await fetch(
			`https://api.ultramsg.com/${env.ULTRAMSG_INSTANCE}/messages/chat`,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: params.toString(),
			},
		);

		const data = (await response.json()) as any;

		if (data.status === "success") {
			return { success: true };
		}

		console.error("UltraMsg error:", data);
		return { success: false, error: data.message || "Error desconocido" };
	} catch (error) {
		console.error("Error WhatsApp:", error);
		return { success: false, error: "Error de conexion" };
	}
}

// =============================================================
// ENDPOINT: POST /api/save-lead
// =============================================================

async function handleSaveLead(request: Request, env: Env): Promise<Response> {
	try {
		const body = (await request.json()) as {
			telefono?: string;
			patente?: string;
			mes_manual?: number;
		};

		const { telefono, patente, mes_manual } = body;

		// Validaciones
		if (!telefono || !patente) {
			return jsonResponse(
				{ success: false, error: "Telefono y patente son requeridos" },
				400,
			);
		}

		const patenteClean = sanitizarPatente(patente);
		if (patenteClean.length < 5) {
			return jsonResponse(
				{ success: false, error: "Patente invalida (minimo 5 caracteres)" },
				400,
			);
		}

		const telefonoClean = sanitizarTelefono(telefono);
		if (telefonoClean.length < 11) {
			return jsonResponse(
				{ success: false, error: "Telefono invalido (ej: +56912345678)" },
				400,
			);
		}

		const ultimoChar = patenteClean.charAt(patenteClean.length - 1);
		let mesRevision: number;
		let esManual = 0;

		// Si el usuario selecciono mes manual
		if (mes_manual && mes_manual >= 1 && mes_manual <= 12) {
			mesRevision = mes_manual;
			esManual = 1;
		} else {
			// Calcular automaticamente
			const autoMes = calcularMesRevision(ultimoChar);
			if (!autoMes) {
				return jsonResponse({
					success: false,
					error:
						"No se pudo calcular el mes automaticamente. El ultimo caracter '" +
						ultimoChar +
						"' no es un digito valido. Selecciona el mes manualmente.",
					ultimo_caracter: ultimoChar,
					necesita_manual: true,
				}, 400);
			}
			mesRevision = autoMes;
			esManual = 0;
		}

		// Insertar o actualizar (INSERT OR REPLACE por el unique index)
		try {
			await env.DB.prepare(
				`INSERT INTO recordatorios_revision 
         (telefono, patente, ultimo_caracter, mes_revision, es_manual, fecha_registro, ultimo_aviso_enviado, activo)
         VALUES (?, ?, ?, ?, ?, datetime('now', '-4 hours'), '', 1)`,
			)
				.bind(telefonoClean, patenteClean, ultimoChar, mesRevision, esManual)
				.run();
		} catch (e: any) {
			// Si viola UNIQUE constraint, actualizar el existente
			if (e.message && e.message.includes("UNIQUE")) {
				await env.DB.prepare(
					`UPDATE recordatorios_revision 
           SET mes_revision = ?, es_manual = ?, ultimo_caracter = ?, activo = 1, ultimo_aviso_enviado = ''
           WHERE patente = ? AND telefono = ?`,
				)
					.bind(mesRevision, esManual, ultimoChar, patenteClean, telefonoClean)
					.run();
			} else {
				throw e;
			}
		}

		// Enviar mensaje de bienvenida via WhatsApp
		const msgBienvenida =
			"¡Hola! 🚗 Te has registrado en Global Pro Automotriz.\n\n" +
			"Te recordaremos cuando se acerque tu revisión técnica " +
			"(patente " +
			patenteClean +
			", mes de " +
			MESES_NOMBRES[mesRevision] +
			").\n\n" +
			"Si necesitas un mecánico a domicilio, ¡escríbenos! 📲\n" +
			"WhatsApp: +56 9 390 26185\n" +
			"Web: mecanico247.com";

		await sendWhatsApp(telefonoClean, msgBienvenida, env);

		return jsonResponse({
			success: true,
			patente: patenteClean,
			telefono: telefonoClean,
			mes_revision: mesRevision,
			nombre_mes: MESES_NOMBRES[mesRevision],
			es_manual: esManual === 1,
			mensaje:
				"¡Registrado! Te avisaremos por WhatsApp cuando se acerque " +
				MESES_NOMBRES[mesRevision] +
				".",
		});
	} catch (error) {
		console.error("Error en save-lead:", error);
		return jsonResponse({ success: false, error: "Error interno del servidor" }, 500);
	}
}

// =============================================================
// ENDPOINT: POST /api/unsubscribe
// =============================================================

async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
	try {
		const body = (await request.json()) as {
			telefono?: string;
			patente?: string;
		};
		const { telefono, patente } = body;

		if (!telefono) {
			return jsonResponse({ success: false, error: "Telefono requerido" }, 400);
		}

		const telefonoClean = sanitizarTelefono(telefono);
		const patenteClean = patente ? sanitizarPatente(patente) : null;

		if (patenteClean) {
			await env.DB.prepare(
				"UPDATE recordatorios_revision SET activo = 0 WHERE telefono = ? AND patente = ?",
			)
				.bind(telefonoClean, patenteClean)
				.run();
		} else {
			await env.DB.prepare(
				"UPDATE recordatorios_revision SET activo = 0 WHERE telefono = ?",
			)
				.bind(telefonoClean)
				.run();
		}

		return jsonResponse({
			success: true,
			mensaje: "Has sido dado de baja. No recibirás más recordatorios.",
		});
	} catch (error) {
		console.error("Error en unsubscribe:", error);
		return jsonResponse({ success: false, error: "Error interno" }, 500);
	}
}

// =============================================================
// ENDPOINT: GET /api/check?patente=X
// =============================================================

async function handleCheck(url: URL, env: Env): Promise<Response> {
	try {
		const patente = url.searchParams.get("patente");
		if (!patente) {
			return jsonResponse({ success: false, error: "Parametro 'patente' requerido" }, 400);
		}

		const patenteClean = sanitizarPatente(patente);
		const ultimoChar = patenteClean.charAt(patenteClean.length - 1);
		const mesAuto = calcularMesRevision(ultimoChar);

		return jsonResponse({
			success: true,
			patente: patenteClean,
			ultimo_caracter: ultimoChar,
			mes_revision: mesAuto,
			nombre_mes: mesAuto ? MESES_NOMBRES[mesAuto] : null,
			es_auto: mesAuto !== null,
			necesita_manual: mesAuto === null,
		});
	} catch (error) {
		return jsonResponse({ success: false, error: "Error interno" }, 500);
	}
}

// =============================================================
// ENDPOINT: GET /api/trigger?secret=X (testing manual)
// =============================================================

async function handleTriggerReminders(url: URL, env: Env): Promise<Response> {
	const secret = url.searchParams.get("secret");
	if (secret !== env.CRON_SECRET) {
		return jsonResponse({ success: false, error: "No autorizado" }, 403);
	}

	const result = await processReminders(env);
	return jsonResponse({ success: true, ...result });
}

// =============================================================
// LOGICA PRINCIPAL: PROCESAR RECORDATORIOS
// =============================================================

async function processReminders(
	env: Env,
): Promise<{ sent: number; errors: number; total: number; mes: string; year: number }> {
	const now = new Date();

	// Chile: UTC-4 (invierno) o UTC-3 (verano)
	// Usamos UTC-4 como base (siempre 1 hora antes en verano, aceptable)
	const chileTime = new Date(now.getTime() - 4 * 60 * 60 * 1000);
	const currentMonth = chileTime.getUTCMonth() + 1;
	const currentYear = chileTime.getUTCFullYear();
	const monthYear = `${String(currentMonth).padStart(2, "0")}-${currentYear}`;
	const mesNombre = MESES_NOMBRES[currentMonth];

	console.log(
		`[CRON] Procesando recordatorios para ${mesNombre} ${currentYear} (${monthYear})`,
	);

	// Buscar leads del mes actual que no han recibido aviso
	const { results } = await env.DB.prepare(
		`SELECT * FROM recordatorios_revision 
     WHERE mes_revision = ? 
       AND (ultimo_aviso_enviado IS NULL OR ultimo_aviso_enviado != ?) 
       AND activo = 1`,
	)
		.bind(currentMonth, monthYear)
		.all();

	const leads = results as LeadRecord[];
	let sent = 0;
	let errors = 0;

	for (const lead of leads) {
		const mensaje =
			"¡Hola! 🚗 En Global Pro te recordamos que este mes (" +
			mesNombre +
			") vence la revisión técnica de tu patente " +
			lead.patente +
			".\n\n" +
			"¿Te gustaría agendar una revisión preventiva a domicilio para ir a la segura?\n\n" +
			"Responde a este mensaje o escríbenos al +56 9 390 26185 📲";

		const result = await sendWhatsApp(lead.telefono, mensaje, env);

		if (result.success) {
			await env.DB.prepare(
				"UPDATE recordatorios_revision SET ultimo_aviso_enviado = ? WHERE id = ?",
			)
				.bind(monthYear, lead.id)
				.run();
			sent++;
		} else {
			console.error(
				`[CRON] Error enviando a ${lead.telefono}: ${result.error}`,
			);
			errors++;
		}

		// Pausa de 1 segundo entre mensajes para no saturar UltraMsg
		if (sent + errors < leads.length) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}

	console.log(
		`[CRON] Resultado: ${sent} enviados, ${errors} errores, ${leads.length} total`,
	);

	return { sent, errors, total: leads.length, mes: mesNombre, year: currentYear };
}

// =============================================================
// WORKER EXPORT
// =============================================================

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// CORS preflight
		if (request.method === "OPTIONS") {
			return corsResponse(null, { status: 204 });
		}

		// API endpoints
		if (url.pathname === "/api/save-lead" && request.method === "POST") {
			return handleSaveLead(request, env);
		}

		if (url.pathname === "/api/unsubscribe" && request.method === "POST") {
			return handleUnsubscribe(request, env);
		}

		if (url.pathname === "/api/check" && request.method === "GET") {
			return handleCheck(url, env);
		}

		if (url.pathname === "/api/trigger" && request.method === "GET") {
			return handleTriggerReminders(url, env);
		}

		// Stats endpoint (publico, para mostrar en landing)
		if (url.pathname === "/api/stats") {
			try {
				const total = await env.DB.prepare(
					"SELECT COUNT(*) as count FROM recordatorios_revision WHERE activo = 1",
				).first<{ count: number }>();
				const esteMes = await env.DB.prepare(
					"SELECT COUNT(*) as count FROM recordatorios_revision WHERE mes_revision = ? AND activo = 1",
				)
					.bind(new Date().getMonth() + 1)
					.first<{ count: number }>();
				return jsonResponse({
					success: true,
					total_registrados: total?.count || 0,
					revisan_este_mes: esteMes?.count || 0,
				});
			} catch {
				return jsonResponse({ success: true, total_registrados: 0, revisan_este_mes: 0 });
			}
		}

		return corsResponse("Not Found", { status: 404 });
	},

	async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
		console.log("[CRON] Ejecutando recordatorios programados...");
		try {
			const result = await processReminders(env);
			console.log(`[CRON] Completado: ${JSON.stringify(result)}`);
		} catch (error) {
			console.error("[CRON] Error fatal:", error);
		}
	},
} satisfies ExportedHandler<Env>;
