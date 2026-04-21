/**
 * =============================================================
 * SISTEMA DE FIDELIZACION - GLOBAL PRO AUTOMOTRIZ
 * Worker: Recordatorios de Revision Tecnica via WhatsApp
 * =============================================================
 * 
 * Endpoints:
 *   POST /api/save-lead      - Guardar nuevo lead (patente + telefono)
 *   POST /api/unsubscribe     - Darse de baja de recordatorios
 *   GET  /api/check           - Consultar mes de revision + si ya esta registrado
 *   GET  /api/trigger?secret=X - Forzar envio manual (testing)
 *   GET  /api/stats           - Estadisticas publicas
 * 
 * Cron: Todos los dias a las 09:00 Chile (UTC 13:00)
 * 
 * Recordatorios: 30 dias, 15 dias y 7 dias antes del mes de revision
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

// Etapas de recordatorio (dias antes del mes de revision)
const ETAPAS_RECORDATORIO = [
	{ dias: 30, etiqueta: "30d" },
	{ dias: 15, etiqueta: "15d" },
	{ dias: 7,  etiqueta: "7d"  },
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
	// Solo limpiar: quitar +, espacios, guiones, parentesis, puntos
	// NO agregar prefijo de pais - el usuario debe ingresar el numero completo
	return tel.replace(/[\s\-\+\(\)\.]/g, "");
}

function sanitizarPatente(pat: string): string {
	return pat.toUpperCase().replace(/[\s\.\-·\-]/g, "");
}

/**
 * Obtiene la hora actual en Chile (UTC-4 como base)
 */
function getChileTime(): Date {
	const now = new Date();
	return new Date(now.getTime() - 4 * 60 * 60 * 1000);
}

/**
 * Genera la clave de tracking para una etapa de recordatorio
 * Formato: "30d|2025", "15d|2025", "7d|2025"
 */
function etapaKey(etiqueta: string, year: number): string {
	return `${etiqueta}|${year}`;
}

/**
 * Verifica si una etapa ya fue enviada para un lead
 * Soporta formato nuevo "30d|2025,15d|2025" y formato viejo "04-2025"
 */
function etapaEnviada(ultimoAviso: string, etiqueta: string, year: number): boolean {
	if (!ultimoAviso) return false;

	// Formato nuevo: contiene "30d|2025" etc
	if (ultimoAviso.includes(etiqueta + "|" + year)) return true;

	// Formato viejo (ej: "04-2025") - lo tratamos como ciclo completo pasado
	if (/^\d{2}-\d{4}$/.test(ultimoAviso)) return true;

	return false;
}

/**
 * Agrega una etapa al tracking de avisos
 */
function agregarEtapa(ultimoAviso: string, etiqueta: string, year: number): string {
	const key = etapaKey(etiqueta, year);
	if (!ultimoAviso || ultimoAviso === "") return key;

	// Si esta en formato viejo, empezar de nuevo con el formato nuevo
	if (/^\d{2}-\d{4}$/.test(ultimoAviso)) return key;

	return ultimoAviso + "," + key;
}

/**
 * Calcula la proxima fecha de revision (1ero del mes de revision)
 * Si ya paso este año, usa el proximo año
 */
function proximaFechaRevision(mesRevision: number, chileTime: Date): { fecha: Date; year: number } {
	const currentYear = chileTime.getUTCFullYear();
	let revisionDate = new Date(Date.UTC(currentYear, mesRevision - 1, 1));

	// Si el mes de revision ya paso este ano (o estamos en el mes pero es muy tarde), usar proximo ano
	if (revisionDate.getTime() <= chileTime.getTime()) {
		revisionDate = new Date(Date.UTC(currentYear + 1, mesRevision - 1, 1));
	}

	return { fecha: revisionDate, year: revisionDate.getUTCFullYear() };
}

/**
 * Enmascara un telefono para mostrar parcialmente
 * Ej: "56912345678" -> "**5678"
 */
function enmascararTelefono(tel: string): string {
	if (tel.length < 5) return "****";
	return "****" + tel.slice(-4);
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

		// Verificar si la patente ya existe en la base de datos
		const existente = await env.DB.prepare(
			"SELECT id, telefono, mes_revision, activo FROM recordatorios_revision WHERE patente = ? AND activo = 1",
		)
			.bind(patenteClean)
			.first<{ id: number; telefono: string; mes_revision: number; activo: number }>();

		let esNuevo = true;

		if (existente) {
			esNuevo = false;

			// Si es el mismo telefono, actualizar el registro existente
			if (existente.telefono === telefonoClean) {
				await env.DB.prepare(
					`UPDATE recordatorios_revision 
		     SET mes_revision = ?, es_manual = ?, ultimo_caracter = ?, activo = 1, ultimo_aviso_enviado = ''
		     WHERE id = ?`,
				)
					.bind(mesRevision, esManual, ultimoChar, existente.id)
					.run();
			} else {
				// Telefono diferente - insertar como nuevo registro (mismo telefono puede tener multiples patentes)
				try {
					await env.DB.prepare(
						`INSERT INTO recordatorios_revision 
		   (telefono, patente, ultimo_caracter, mes_revision, es_manual, fecha_registro, ultimo_aviso_enviado, activo)
		   VALUES (?, ?, ?, ?, ?, datetime('now', '-4 hours'), '', 1)`,
					)
						.bind(telefonoClean, patenteClean, ultimoChar, mesRevision, esManual)
						.run();
					esNuevo = true; // Es nuevo para este telefono
				} catch (e: any) {
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
			}
		} else {
			// No existe, insertar nuevo
			try {
				await env.DB.prepare(
					`INSERT INTO recordatorios_revision 
       (telefono, patente, ultimo_caracter, mes_revision, es_manual, fecha_registro, ultimo_aviso_enviado, activo)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-4 hours'), '', 1)`,
				)
					.bind(telefonoClean, patenteClean, ultimoChar, mesRevision, esManual)
					.run();
			} catch (e: any) {
				if (e.message && e.message.includes("UNIQUE")) {
					await env.DB.prepare(
						`UPDATE recordatorios_revision 
       SET mes_revision = ?, es_manual = ?, ultimo_caracter = ?, activo = 1, ultimo_aviso_enviado = ''
       WHERE patente = ? AND telefono = ?`,
					)
						.bind(mesRevision, esManual, ultimoChar, patenteClean, telefonoClean)
						.run();
					esNuevo = false;
				} else {
					throw e;
				}
			}
		}

		// Enviar mensaje de bienvenida via WhatsApp
		const msgBienvenida =
			"¡Hola! 🚗 Te has registrado en Global Pro Automotriz.\n\n" +
			"Te recordaremos con avisos a *30 días*, *15 días* y *7 días* antes de tu revisión técnica " +
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
			es_nuevo: esNuevo,
			ya_registrado: !esNuevo && existente !== null,
			telefono_existente: existente ? enmascararTelefono(existente.telefono) : null,
			mensaje: esNuevo
				? "¡Registrado! Recibirás 3 avisos por WhatsApp (30, 15 y 7 días antes)."
				: "¡Actualizado! Ya estabas registrado. Recibirás 3 avisos (30, 15 y 7 días antes).",
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
// Ahora tambien consulta la BD para ver si ya esta registrado
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

		// Consultar BD para ver si ya esta registrada
		let registro = null;
		try {
			const existing = await env.DB.prepare(
				"SELECT id, telefono, mes_revision, es_manual, fecha_registro, activo FROM recordatorios_revision WHERE patente = ? AND activo = 1",
			)
				.bind(patenteClean)
				.first<{ id: number; telefono: string; mes_revision: number; es_manual: number; fecha_registro: string; activo: number }>();

			if (existing) {
				registro = {
					encontrado: true,
					telefono: enmascararTelefono(existing.telefono),
					mes_revision: existing.mes_revision,
					nombre_mes: MESES_NOMBRES[existing.mes_revision],
					es_manual: existing.es_manual === 1,
					fecha_registro: existing.fecha_registro,
				};
			}
		} catch {
			// Si la BD no esta disponible, continuar sin info de registro
		}

		return jsonResponse({
			success: true,
			patente: patenteClean,
			ultimo_caracter: ultimoChar,
			mes_revision: mesAuto,
			nombre_mes: mesAuto ? MESES_NOMBRES[mesAuto] : null,
			es_auto: mesAuto !== null,
			necesita_manual: mesAuto === null,
			registrado: registro?.encontrado ?? false,
			registro: registro,
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
// LOGICA PRINCIPAL: PROCESAR RECORDATORIOS (30d, 15d, 7d)
// =============================================================

async function processReminders(
	env: Env,
): Promise<{ sent: number; errors: number; total: number; detalles: string[] }> {
	const chileTime = getChileTime();
	const currentMonth = chileTime.getUTCMonth() + 1;
	const currentYear = chileTime.getUTCFullYear();

	console.log(
		`[CRON] Procesando recordatorios - ${chileTime.toISOString()} Chile approx`,
	);

	// Obtener TODOS los leads activos
	const { results } = await env.DB.prepare(
		"SELECT * FROM recordatorios_revision WHERE activo = 1",
	).all();

	const leads = results as LeadRecord[];
	let sent = 0;
	let errors = 0;
	const detalles: string[] = [];

	for (const lead of leads) {
		// Calcular proxima fecha de revision
		const { fecha: revisionDate, year: revisionYear } = proximaFechaRevision(
			lead.mes_revision,
			chileTime,
		);

		// Calcular dias restantes hasta el 1ero del mes de revision
		const diffMs = revisionDate.getTime() - chileTime.getTime();
		const diasRestantes = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

		// Determinar que etapa enviar segun los dias restantes
		let etapaActual: (typeof ETAPAS_RECORDATORIO)[number] | null = null;

		// Buscar la etapa mas apropiada
		// Prioridad: enviar la etapa que corresponda al rango actual
		if (diasRestantes <= 30 && diasRestantes > 15) {
			etapaActual = ETAPAS_RECORDATORIO.find(e => e.etiqueta === "30d") || null;
		} else if (diasRestantes <= 15 && diasRestantes > 7) {
			etapaActual = ETAPAS_RECORDATORIO.find(e => e.etiqueta === "15d") || null;
		} else if (diasRestantes <= 7 && diasRestantes >= 0) {
			etapaActual = ETAPAS_RECORDATORIO.find(e => e.etiqueta === "7d") || null;
		}

		// Si no estamos en ninguna ventana, verificar si nos saltamos alguna etapa
		// (por ejemplo, si el cron no corrio un dia y pasamos de 31 a 14 dias)
		if (!etapaActual && diasRestantes <= 30 && diasRestantes >= 0) {
			for (const etapa of ETAPAS_RECORDATORIO) {
				if (!etapaEnviada(lead.ultimo_aviso_enviado, etapa.etiqueta, revisionYear)) {
					if (diasRestantes <= etapa.dias) {
						etapaActual = etapa;
						break;
					}
				}
			}
		}

		if (!etapaActual) continue;

		// Verificar si esta etapa ya fue enviada
		if (etapaEnviada(lead.ultimo_aviso_enviado, etapaActual.etiqueta, revisionYear)) {
			continue;
		}

		// Generar mensaje segun la etapa
		const mensaje = generarMensajeRecordatorio(
			lead.patente,
			MESES_NOMBRES[lead.mes_revision],
			revisionYear,
			diasRestantes,
			etapaActual.etiqueta,
		);

		// Enviar WhatsApp
		const result = await sendWhatsApp(lead.telefono, mensaje, env);

		if (result.success) {
			// Actualizar tracking
			const nuevoTracking = agregarEtapa(
				lead.ultimo_aviso_enviado,
				etapaActual.etiqueta,
				revisionYear,
			);
			await env.DB.prepare(
				"UPDATE recordatorios_revision SET ultimo_aviso_enviado = ? WHERE id = ?",
			)
				.bind(nuevoTracking, lead.id)
				.run();
			sent++;
			detalles.push(`${lead.patente}: ${etapaActual.etiqueta} enviada (${diasRestantes}d restantes)`);
		} else {
			console.error(
				`[CRON] Error enviando a ${lead.telefono}: ${result.error}`,
			);
			errors++;
		}

		// Pausa de 1 segundo entre mensajes para no saturar UltraMsg
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	console.log(
		`[CRON] Resultado: ${sent} enviados, ${errors} errores, ${leads.length} total procesados`,
	);

	return { sent, errors, total: leads.length, detalles };
}

/**
 * Genera el mensaje de WhatsApp segun la etapa del recordatorio
 */
function generarMensajeRecordatorio(
	patente: string,
	nombreMes: string,
	year: number,
	diasRestantes: number,
	etiqueta: string,
): string {
	const baseInfo = `patente ${patente}, revision en ${nombreMes} ${year}`;

	let urgencia = "";
	let emoji = "🚗";

	switch (etiqueta) {
		case "30d":
			urgencia = `Faltan aproximadamente *${diasRestantes} días* para el inicio de tu mes de revisión técnica.`;
			emoji = "📅";
			break;
		case "15d":
			urgencia = `⏰ *¡Solo faltan ${diasRestantes} días*! Se acerca tu mes de revisión técnica.`;
			emoji = "⚠️";
			break;
		case "7d":
			urgencia = `🔴 *¡URGENTE! Faltan solo ${diasRestantes} días* para tu revisión técnica.`;
			emoji = "🚨";
			break;
	}

	return (
		`${emoji} *Recordatorio de Global Pro Automotriz*\n\n` +
		`${urgencia}\n\n` +
		`Vehículo: *${baseInfo}*\n\n` +
		`¿Te gustaría agendar una revisión preventiva a domicilio para ir a la segura?\n\n` +
		`Responde a este mensaje o escríbenos al +56 9 390 26185 📲\n` +
		`Web: mecanico247.com`
	);
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
		console.log("[CRON] Ejecutando recordatorios programados (30d/15d/7d)...");
		try {
			const result = await processReminders(env);
			console.log(`[CRON] Completado: ${JSON.stringify(result)}`);
		} catch (error) {
			console.error("[CRON] Error fatal:", error);
		}
	},
} satisfies ExportedHandler<Env>;
