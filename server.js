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

pool.connect().then(() => console.log('✅ Conexión exitosa a Neon')).catch(err => console.error('❌ Error Neon:', err));

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

// 3. INVENTARIO: CREAR PRODUCTO NUEVO
app.post('/api/productos', verificarToken, async (req, res) => {
    try {
        const { codigo, nombre, stock, precio_adquisicion, precio_venta } = req.body;
        const nuevoProd = await pool.query(
            'INSERT INTO productos (bodega_id, codigo, nombre, stock, precio_adquisicion, precio_venta) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [req.bodega.bodega_id, codigo, nombre, stock, precio_adquisicion, precio_venta]
        );
        res.json({ mensaje: 'Producto creado', producto: nuevoProd.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error guardando producto' }); }
});

app.get('/api/productos', verificarToken, async (req, res) => {
    try {
        const productos = await pool.query('SELECT * FROM productos WHERE bodega_id = $1 ORDER BY nombre ASC', [req.bodega.bodega_id]);
        res.json(productos.rows);
    } catch (error) { res.status(500).json({ error: 'Error obteniendo inventario' }); }
});

// --- 4. NUEVO: MÓDULO INTELIGENTE DE RESTOCK ---
app.post('/api/restock', verificarToken, async (req, res) => {
    const cliente = await pool.connect();
    try {
        await cliente.query('BEGIN'); // Transacción segura
        const { producto_id, cantidad_sumar, precio_adquisicion, precio_venta, tasa_aplicada } = req.body;
        const bodega_id = req.bodega.bodega_id;

        // A. Sumamos la cantidad nueva al stock existente
        await cliente.query(
            'UPDATE productos SET stock = stock + $1, precio_adquisicion = $2, precio_venta = $3 WHERE id = $4 AND bodega_id = $5',
            [cantidad_sumar, precio_adquisicion, precio_venta, producto_id, bodega_id]
        );

        // B. Calculamos cuánto nos costó esa mercancía y lo registramos como EGRESO
        const costo_total_usd = cantidad_sumar * precio_adquisicion;
        await cliente.query(
            `INSERT INTO transacciones (bodega_id, tipo, categoria, monto_usd, tasa_aplicada, forma_pago, descripcion)
             VALUES ($1, 'Egreso', 'Compra de Mercancía', $2, $3, 'Efectivo', $4)`,
            [bodega_id, costo_total_usd, tasa_aplicada, `Restock: +${cantidad_sumar} unidades agregadas al inventario.`]
        );

        await cliente.query('COMMIT');
        res.json({ mensaje: 'Restock procesado y gasto registrado en movimientos.' });
    } catch (error) {
        await cliente.query('ROLLBACK');
        res.status(500).json({ error: 'Error procesando el restock.' });
    } finally {
        cliente.release();
    }
});

// --- 5. NUEVO: CAMBIAR SOLO EL PRECIO ---
app.put('/api/productos/:id/precio', verificarToken, async (req, res) => {
    try {
        await pool.query(
            'UPDATE productos SET precio_venta = $1 WHERE id = $2 AND bodega_id = $3',
            [req.body.precio_venta, req.params.id, req.bodega.bodega_id]
        );
        res.json({ mensaje: 'Precio actualizado correctamente.' });
    } catch (error) { res.status(500).json({ error: 'Error actualizando precio.' }); }
});

// 6. POS Y MOVIMIENTOS
app.post('/api/transacciones', verificarToken, async (req, res) => {
    const cliente = await pool.connect();
    try {
        await cliente.query('BEGIN');
        const { tipo, categoria, monto_usd, tasa_aplicada, forma_pago, descripcion, carrito } = req.body;
        const bodega_id = req.bodega.bodega_id;

        const resTrans = await cliente.query(
            `INSERT INTO transacciones (bodega_id, tipo, categoria, monto_usd, tasa_aplicada, forma_pago, descripcion) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
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
        res.json({ mensaje: 'Venta registrada y stock descontado', transaccion_id });
    } catch (error) {
        await cliente.query('ROLLBACK');
        res.status(500).json({ error: 'Error en venta' });
    } finally { cliente.release(); }
});

app.get('/api/transacciones', verificarToken, async (req, res) => {
    try {
        const trans = await pool.query('SELECT * FROM transacciones WHERE bodega_id = $1 ORDER BY fecha_hora DESC', [req.bodega.bodega_id]);
        res.json(trans.rows);
    } catch (error) { res.status(500).json({ error: 'Error en movimientos' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
