-- =============================================================
-- SISTEMA DE FIDELIZACION - GLOBAL PRO AUTOMOTRIZ
-- Tabla: recordatorios_revision
-- Base de datos: tallerv2_db (D1)
-- =============================================================

-- Crear tabla principal
CREATE TABLE IF NOT EXISTS recordatorios_revision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT NOT NULL,
  patente TEXT NOT NULL,
  ultimo_caracter TEXT DEFAULT '',
  mes_revision INTEGER NOT NULL,
  es_manual INTEGER DEFAULT 0,
  fecha_registro TEXT DEFAULT (datetime('now', '-4 hours')),
  ultimo_aviso_enviado TEXT DEFAULT '',
  activo INTEGER DEFAULT 1
);

-- Indice unico para evitar duplicados (misma patente + telefono)
CREATE UNIQUE INDEX IF NOT EXISTS idx_patente_telefono 
ON recordatorios_revision(patente, telefono);

-- Indice para la consulta del cron (mes + activo + aviso)
CREATE INDEX IF NOT EXISTS idx_cron_consulta 
ON recordatorios_revision(mes_revision, activo, ultimo_aviso_enviado);

-- =============================================================
-- NOTAS:
-- - mes_revision: numero del mes (1=Enero, 2=Febrero, ..., 12=Diciembre)
-- - es_manual: 0 = calculado por patente, 1 = seleccionado por usuario
-- - ultimo_aviso_enviado: formato 'MM-YYYY', ejemplo '04-2026'
-- - activo: 1 = activo, 0 = dado de baja
-- - fecha_registro: timestamp Chile (UTC-4)
-- =============================================================
