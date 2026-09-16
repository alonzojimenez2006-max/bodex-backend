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

pool.connect()
    .then(() => console.log('✅ Conexión exitosa a la base de datos de Neon'))
    .catch(err => console.error('❌ Error conectando a Neon:', err.stack));

// --- GUARDIÁN DE SEGURIDAD ---
const verificarToken = (req, res, next) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ error: 'Acceso denegado.' });
    try {
        const tokenLimpio = token.replace('Bearer ', '');
        const verificado = jwt.verify(tokenLimpio, process.env.JWT_SECRET);
        req.bodega = verificado;
        next();
    } catch (error) {
        res.status(400).json({ error: 'Token no válido.' });
    }
};

// 1. BODEGAS
app.post('/api/bodegas', async (req, res) => {
    try {
        const { nombre_tienda, usuario_admin, password } = req.body;
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);
        const nuevaBodega = await pool.query(
            'INSERT INTO bodegas (nombre_tienda, usuario_admin, password_hash) VALUES ($1, $2, $3) RETURNING id, nombre_tienda',
            [nombre_tienda, usuario_admin, hash]
        );
        res.json({ mensaje: '¡Tienda creada exitosamente!', bodega: nuevaBodega.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error creando tienda' }); }
});

// 2. LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { usuario_admin, password } = req.body;
        const bodega = await pool.query('SELECT * FROM bodegas WHERE usuario_admin = $1', [usuario_admin]);
        if (bodega.rows.length === 0) return res.status(401).json({ error: 'Usuario incorrecto' });
        const passValida = await bcrypt.compare(password, bodega.rows[0].password_hash);
        if (!passValida) return res.status(401).json({ error: 'Contraseña incorrecta' });
        if (!bodega.rows[0].suscripcion_activa) return res.status(403).json({ error: 'Suscripción inactiva.' });
        const token = jwt.sign({ bodega_id: bodega.rows[0].id }, process.env.JWT_SECRET, { expiresIn: '12h' });
        res.json({ mensaje: '¡Login exitoso!', token });
    } catch (error) { res.status(500).json({ error: 'Error en login' }); }
});

// 3. TASA DÓLAR
app.post('/api/tasa', verificarToken, async (req, res) => {
    try {
        const nuevaTasa = await pool.query(
            'INSERT INTO historial_tasas (bodega_id, tasa) VALUES ($1, $2) RETURNING *',
            [req.bodega.bodega_id, req.body.tasa]
        );
        res.json({ mensaje: 'Tasa guardada', registro: nuevaTasa.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error en tasa' }); }
});

// 4. CREAR PRODUCTO
app.post('/api/productos', verificarToken, async (req, res) => {
    try {
        const { codigo, nombre, stock, precio_adquisicion, precio_venta } = req.body;
        const nuevoProd = await pool.query(
            'INSERT INTO productos (bodega_id, codigo, nombre, stock, precio_adquisicion, precio_venta) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [req.bodega.bodega_id, codigo, nombre, stock, precio_adquisicion, precio_venta]
        );
        res.json({ mensaje: 'Producto registrado', producto: nuevoProd.rows[0] });
    } catch (error) { res.status(500).json({ error: 'Error guardando producto' }); }
});

// 5. VER INVENTARIO
app.get('/api/productos', verificarToken, async (req, res) => {
    try {
        const productos = await pool.query('SELECT * FROM productos WHERE bodega_id = $1 ORDER BY nombre ASC', [req.bodega.bodega_id]);
        res.json(productos.rows);
    } catch (error) { res.status(500).json({ error: 'Error obteniendo inventario' }); }
});

// --- 6. MÓDULO POS: REGISTRAR VENTA Y DESCONTAR STOCK ---
app.post('/api/transacciones', verificarToken, async (req, res) => {
    const cliente = await pool.connect(); 
    try {
        await cliente.query('BEGIN'); // Iniciar proceso seguro
        const { tipo, categoria, monto_usd, tasa_aplicada, forma_pago, descripcion, carrito } = req.body;
        const bodega_id = req.bodega.bodega_id;

        // Guardar el recibo general
        const resTrans = await cliente.query(
            `INSERT INTO transacciones (bodega_id, tipo, categoria, monto_usd, tasa_aplicada, forma_pago, descripcion)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [bodega_id, tipo, categoria, monto_usd, tasa_aplicada, forma_pago, descripcion]
        );
        const transaccion_id = resTrans.rows[0].id;

        // Leer el carrito y descontar inventario
        if (carrito && carrito.length > 0) {
            for (let item of carrito) {
                await cliente.query(
                    `INSERT INTO detalles_transaccion (transaccion_id, producto_id, cantidad, precio_unitario) VALUES ($1, $2, $3, $4)`,
                    [transaccion_id, item.producto_id, item.cantidad, item.precio_unitario]
                );
                await cliente.query(
                    `UPDATE productos SET stock = stock - $1 WHERE id = $2 AND bodega_id = $3`,
                    [item.cantidad, item.producto_id, bodega_id]
                );
            }
        }
        await cliente.query('COMMIT'); // Guardar todo definitivamente
        res.json({ mensaje: 'Venta registrada y stock descontado', transaccion_id });
    } catch (error) {
        await cliente.query('ROLLBACK'); // Si algo falla, abortar para no dañar datos
        res.status(500).json({ error: 'Error procesando la venta' });
    } finally {
        cliente.release();
    }
});

// --- 7. MÓDULO REPORTES: VER MOVIMIENTOS ---
app.get('/api/transacciones', verificarToken, async (req, res) => {
    try {
        const transacciones = await pool.query('SELECT * FROM transacciones WHERE bodega_id = $1 ORDER BY fecha_hora DESC', [req.bodega.bodega_id]);
        res.json(transacciones.rows);
    } catch (error) { res.status(500).json({ error: 'Error obteniendo historial' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});