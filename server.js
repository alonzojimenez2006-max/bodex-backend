require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Inicialización y verificación de columnas (Papelera y SuperAdmin)
pool.connect().then(async () => {
    console.log('✅ Conexión exitosa a Neon');
    // Columnas de Papelera
    await pool.query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS eliminado BOOLEAN DEFAULT FALSE;');
    await pool.query('ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS eliminado BOOLEAN DEFAULT FALSE;');
    
    // 🆕 Columnas nuevas para el Panel de Alquileres / SuperAdmin
    await pool.query('ALTER TABLE bodegas ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT \'activo\';');
    await pool.query('ALTER TABLE bodegas ADD COLUMN IF NOT EXISTS ultimo_pago DATE;');
    await pool.query('ALTER TABLE bodegas ADD COLUMN IF NOT EXISTS proximo_pago DATE;');
}).catch(err => console.error('❌ Error Neon:', err));

const verificarToken = (req, res, next) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ error: 'Acceso denegado.' });
    try {
        req.bodega = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET);
        next();
    } catch (error) { res.status(400).json({ error: 'Token no válido.' }); }
};

// 1. BODEGAS Y LOGIN
app.post('/api/bodegas', async (req, res) => {
    try {
        const { nombre_tienda, usuario_admin, password } = req.body;
        const hash = await bcrypt.hash(password, await bcrypt.genSalt(10));
        const nuevaBodega = await pool.query(
            'INSERT INTO bodegas (nombre_tienda, usuario_admin, password_hash) VALUES ($1, $2, $3) RETURNING id, nombre_tienda',
            [nombre_tienda, usuario_admin, hash]
        );
        res.json({ mensaje: 'Tienda creada', bodega: nuevaBodega.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error creando tienda' }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { usuario_admin, password } = req.body;
        const bodega = await pool.query('SELECT * FROM bodegas WHERE usuario_admin = $1', [usuario_admin]);
        if (bodega.rows.length === 0 || !(await bcrypt.compare(password, bodega.rows[0].password_hash))) 
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        
        // --- MODIFICACIÓN AQUÍ: Validar si la cuenta está congelada ---
        if (bodega.rows[0].estado === 'congelado') {
            return res.status(403).json({ error: '⚠️ Tu cuenta está congelada por falta de pago. Comunícate con soporte.' });
        }
        // -------------------------------------------------------------

        const token = jwt.sign({ bodega_id: bodega.rows[0].id }, process.env.JWT_SECRET, { expiresIn: '12h' });
        res.json({ mensaje: 'Login exitoso', token });
    } catch (error) { res.status(500).json({ error: 'Error en login' }); }
});

// 2. TASA DÓLAR
app.post('/api/tasa', verificarToken, async (req, res) => {
    try {
        const nuevaTasa = await pool.query('INSERT INTO historial_tasas (bodega_id, tasa) VALUES ($1, $2) RETURNING *', [req.bodega.bodega_id, req.body.tasa]);
        res.json({ mensaje: 'Tasa guardada', registro: nuevaTasa.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error en tasa' }); }
});

app.get('/api/tasa', verificarToken, async (req, res) => {
    try {
        const resultado = await pool.query('SELECT tasa FROM historial_tasas WHERE bodega_id = $1 ORDER BY fecha_hora DESC LIMIT 1', [req.bodega.bodega_id]);
        res.json({ tasa: resultado.rows.length > 0 ? resultado.rows[0].tasa : 1 });
    } catch (error) { res.status(500).json({ error: 'Error obteniendo tasa' }); }
});

// 3. INVENTARIO (Solo activos)
app.post('/api/productos', verificarToken, async (req, res) => {
    try {
        const { codigo, nombre, stock, precio_adquisicion, precio_venta } = req.body;
        const nuevoProd = await pool.query(
            'INSERT INTO productos (bodega_id, codigo, nombre, stock, precio_adquisicion, precio_venta, eliminado) VALUES ($1, $2, $3, $4, $5, $6, FALSE) RETURNING *',
            [req.bodega.bodega_id, codigo, nombre, stock, precio_adquisicion, precio_venta]
        );
        res.json({ mensaje: 'Producto creado', producto: nuevoProd.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error guardando producto' }); }
});

app.get('/api/productos', verificarToken, async (req, res) => {
    try {
        const productos = await pool.query('SELECT * FROM productos WHERE bodega_id = $1 AND (eliminado = FALSE OR eliminado IS NULL) ORDER BY nombre ASC', [req.bodega.bodega_id]);
        res.json(productos.rows);
    } catch (error) { res.status(500).json({ error: 'Error obteniendo inventario' }); }
});

// RESTOCK & PRECIO
app.post('/api/restock', verificarToken, async (req, res) => {
    const cliente = await pool.connect();
    try {
        await cliente.query('BEGIN');
        const { producto_id, cantidad_sumar, precio_adquisicion, precio_venta, tasa_aplicada } = req.body;
        const bodega_id = req.bodega.bodega_id;

        await cliente.query('UPDATE productos SET stock = stock + $1, precio_adquisicion = $2, precio_venta = $3 WHERE id = $4 AND bodega_id = $5', [cantidad_sumar, precio_adquisicion, precio_venta, producto_id, bodega_id]);
        const costo_total_usd = cantidad_sumar * precio_adquisicion;
        
        await cliente.query(
            `INSERT INTO transacciones (bodega_id, tipo, categoria, monto_usd, tasa_aplicada, forma_pago, descripcion, eliminado)
             VALUES ($1, 'Egreso', 'Compra de Mercancía', $2, $3, 'Efectivo en Dólares', $4, FALSE)`,
            [bodega_id, costo_total_usd, tasa_aplicada, `Restock: +${cantidad_sumar} unidades`]
        );

        await cliente.query('COMMIT');
        res.json({ mensaje: 'Restock procesado.' });
    } catch (error) { await cliente.query('ROLLBACK'); res.status(500).json({ error: 'Error en restock.' }); }
    finally { cliente.release(); }
});

app.put('/api/productos/:id/precio', verificarToken, async (req, res) => {
    try {
        await pool.query('UPDATE productos SET precio_venta = $1 WHERE id = $2 AND bodega_id = $3', [req.body.precio_venta, req.params.id, req.bodega.bodega_id]);
        res.json({ mensaje: 'Precio actualizado.' });
    } catch (error) { res.status(500).json({ error: 'Error actualizando precio.' }); }
});

// 4. POS Y MOVIMIENTOS (Solo activos)
app.post('/api/transacciones', verificarToken, async (req, res) => {
    const cliente = await pool.connect();
    try {
        await cliente.query('BEGIN');
        const { tipo, categoria, monto_usd, tasa_aplicada, forma_pago, descripcion, carrito } = req.body;
        const bodega_id = req.bodega.bodega_id;

        const resTrans = await cliente.query(
            `INSERT INTO transacciones (bodega_id, tipo, categoria, monto_usd, tasa_aplicada, forma_pago, descripcion, eliminado) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE) RETURNING id`,
            [bodega_id, tipo, categoria, monto_usd, tasa_aplicada, forma_pago, descripcion]
        );
        const transaccion_id = resTrans.rows[0].id;

        if (carrito && carrito.length > 0) {
            for (let item of carrito) {
                await cliente.query(`INSERT INTO detalles_transaccion (transaccion_id, producto_id, cantidad, precio_unitario) VALUES ($1, $2, $3, $4)`, [transaccion_id, item.producto_id, item.cantidad, item.precio_unitario]);
                await cliente.query(`UPDATE productos SET stock = stock - $1 WHERE id = $2 AND bodega_id = $3`, [item.cantidad, item.producto_id, bodega_id]);
            }
        }
        await cliente.query('COMMIT');
        res.json({ mensaje: 'Venta registrada', transaccion_id });
    } catch (error) { await cliente.query('ROLLBACK'); res.status(500).json({ error: 'Error en venta' }); }
    finally { cliente.release(); }
});

app.get('/api/transacciones', verificarToken, async (req, res) => {
    try {
        const trans = await pool.query('SELECT * FROM transacciones WHERE bodega_id = $1 AND (eliminado = FALSE OR eliminado IS NULL) ORDER BY fecha_hora DESC', [req.bodega.bodega_id]);
        res.json(trans.rows);
    } catch (error) { res.status(500).json({ error: 'Error en movimientos' }); }
});

// DETALLES DE FACTURA / VENTA
app.get('/api/transacciones/:id/detalles', verificarToken, async (req, res) => {
    try {
        const detalles = await pool.query(
            `SELECT dt.*, p.nombre FROM detalles_transaccion dt JOIN productos p ON dt.producto_id = p.id WHERE dt.transaccion_id = $1`,
            [req.params.id]
        );
        res.json(detalles.rows);
    } catch (error) { res.status(500).json({ error: 'Error obteniendo detalles de factura' }); }
});

// --- 5. MÓDULO PAPELERA (PRODUCTOS Y MOVIMIENTOS) ---
app.get('/api/papelera', verificarToken, async (req, res) => {
    try {
        const prodPapelera = await pool.query('SELECT * FROM productos WHERE bodega_id = $1 AND eliminado = TRUE', [req.bodega.bodega_id]);
        const transPapelera = await pool.query('SELECT * FROM transacciones WHERE bodega_id = $1 AND eliminado = TRUE', [req.bodega.bodega_id]);
        res.json({ productos: prodPapelera.rows, transacciones: transPapelera.rows });
    } catch (error) { res.status(500).json({ error: 'Error obteniendo papelera' }); }
});

// Enviar a papelera
app.put('/api/productos/:id/papelera', verificarToken, async (req, res) => {
    try {
        await pool.query('UPDATE productos SET eliminado = TRUE WHERE id = $1 AND bodega_id = $2', [req.params.id, req.bodega.bodega_id]);
        res.json({ mensaje: 'Producto enviado a la papelera' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/transacciones/:id/papelera', verificarToken, async (req, res) => {
    try {
        await pool.query('UPDATE transacciones SET eliminado = TRUE WHERE id = $1 AND bodega_id = $2', [req.params.id, req.bodega.bodega_id]);
        res.json({ mensaje: 'Movimiento enviado a la papelera' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

// Restaurar
app.put('/api/productos/:id/restaurar', verificarToken, async (req, res) => {
    try {
        await pool.query('UPDATE productos SET eliminado = FALSE WHERE id = $1 AND bodega_id = $2', [req.params.id, req.bodega.bodega_id]);
        res.json({ mensaje: 'Producto restaurado' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.put('/api/transacciones/:id/restaurar', verificarToken, async (req, res) => {
    try {
        await pool.query('UPDATE transacciones SET eliminado = FALSE WHERE id = $1 AND bodega_id = $2', [req.params.id, req.bodega.bodega_id]);
        res.json({ mensaje: 'Movimiento restaurado' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

// Borrar Permanentemente
app.delete('/api/productos/:id/permanente', verificarToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM productos WHERE id = $1 AND bodega_id = $2', [req.params.id, req.bodega.bodega_id]);
        res.json({ mensaje: 'Producto borrado permanentemente' });
    } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/transacciones/:id/permanente', verificarToken, async (req, res) => {
    const cliente = await pool.connect();
    try {
        await cliente.query('BEGIN');
        await cliente.query('DELETE FROM detalles_transaccion WHERE transaccion_id = $1', [req.params.id]);
        await cliente.query('DELETE FROM transacciones WHERE id = $1 AND bodega_id = $2', [req.params.id, req.bodega.bodega_id]);
        await cliente.query('COMMIT');
        res.json({ mensaje: 'Movimiento borrado permanentemente' });
    } catch (error) { await cliente.query('ROLLBACK'); res.status(500).json({ error: 'Error' }); }
    finally { cliente.release(); }
});

// ==========================================
// RUTAS DE SUPERADMIN (Panel Maestro de Alquileres)
// ==========================================

// 1. Ver todas las tiendas registradas con su estado y fechas de pago
app.get('/api/superadmin/bodegas', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT id, nombre_tienda, usuario_admin, estado, ultimo_pago, proximo_pago FROM bodegas ORDER BY id DESC');
        res.json(resultado.rows);
    } catch (error) { 
        res.status(500).json({ error: 'Error obteniendo bodegas' }); 
    }
});

// 2. Cambiar estado (Activo <-> Congelado)
app.put('/api/superadmin/bodegas/:id/estado', async (req, res) => {
    try {
        const { estado } = req.body; // Recibe 'activo' o 'congelado'
        await pool.query('UPDATE bodegas SET estado = $1 WHERE id = $2', [estado, req.params.id]);
        res.json({ mensaje: `Bodega actualizada a estado: ${estado}` });
    } catch (error) { 
        res.status(500).json({ error: 'Error cambiando estado' }); 
    }
});

// 3. Actualizar fechas de pago y registro de abono
app.put('/api/superadmin/bodegas/:id/pagos', async (req, res) => {
    try {
        const { ultimo_pago, proximo_pago } = req.body;
        await pool.query('UPDATE bodegas SET ultimo_pago = $1, proximo_pago = $2 WHERE id = $3', [ultimo_pago, proximo_pago, req.params.id]);
        res.json({ mensaje: 'Fechas de pago actualizadas correctamente' });
    } catch (error) { 
        res.status(500).json({ error: 'Error actualizando pagos' }); 
    }
});

// 4. Borrar una bodega definitivamente
app.delete('/api/superadmin/bodegas/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM bodegas WHERE id = $1', [req.params.id]);
        res.json({ mensaje: 'Bodega eliminada definitivamente' });
    } catch (error) { 
        res.status(500).json({ error: 'Error borrando bodega' }); 
    }
});

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));


