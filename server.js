const detalles = { ...result };
if (comprobante) detalles.comprobante = comprobante;
if (motivo) detalles.motivo = motivo;

await db.collection("audit_log").add({
  accion: `${accion}_solicitud`, targetId: solicitudId,
  adminEmail: req.adminEmail, adminUid: req.adminUid,
  detalles: detalles, createdAt: new Date().toISOString()
});
