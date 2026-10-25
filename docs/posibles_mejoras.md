# Posibles mejoras

Ideas que **pueden o no agregarse**. No son pendientes: se hacen solo si algún cliente las pide o si el uso real demuestra que hacen falta. La numeración es la de la lista original (ver [pendientes.md](pendientes.md) para lo que sí está en curso y lo ya hecho).

## Documentos
| # | Idea | Esfuerzo |
|---|---|---|
| 6 | Reemplazar un archivo conservando título y colección (nueva versión) | medio |
| 7 | Copiar un documento a otra colección sin quitarlo de la original (duplica fragmentos) | medio |
| 8 | Paginación en el servidor si una colección supera los 1000 documentos (hoy es el tope) | medio |
| 9 | Etiquetas o metadatos por documento para filtrar | medio |

## Chat y calidad
| # | Idea | Esfuerzo |
|---|---|---|
| 12 | Conjunto de preguntas de prueba por organización, para medir si la calidad baja al cambiar de modelo o de documentos | alto |
| 14 | Modelo distinto por colección (uno más potente para contratos, por ejemplo) | medio |
| 15 | Retención configurable de conversaciones (borrarlas pasados N días) | bajo-medio |
| — | `max_tokens` por plan, en vez del valor global `LLM_MAX_TOKENS` (útil solo si se quiere diferenciar planes por largo de respuesta) | bajo |
| — | Claude directo (Anthropic): hoy solo vía OpenRouter; requiere un adaptador propio | medio |
| — | Filtrar el razonamiento (`<thought>`) de los modelos Gemma de Google, si algún día se usan | bajo |
| — | Gráficos en las respuestas (barras, líneas, tortas) cuando hay cifras en los documentos: el modelo devuelve los datos en un bloque con formato y la pantalla los dibuja, con la librería cargada solo al primer gráfico. Exige validar el bloque y reforzar la regla de no inventar cifras | medio || — | Diagramas (flujos, organigramas) con Mermaid, que el modelo escribe como texto y la pantalla convierte en dibujo | medio |

## Planes y negocio
| # | Idea | Esfuerzo |
|---|---|---|
| 17 | Costo estimado por organización (tokens por precio del modelo) para facturar | medio |
| 19 | Clave de API propia por organización, cifrada, que prevalezca sobre la global | medio |
| 20 | Botón «organización principal» para el superadministrador (hoy basta el selector de Organizaciones) | bajo |
| 21 | Cobro automático de planes (Stripe u otro) | alto |
| 22 | Alta de organizaciones por autoservicio (hoy solo las crea el superadministrador) | alto |

## Integraciones y acceso
| # | Idea | Esfuerzo |
|---|---|---|
| 24 | Claves de API por organización para integrar otras aplicaciones (hoy la API solo se usa con la sesión del navegador) | medio |
| 25 | Inicio de sesión con Google o Microsoft (SSO) | alto |
| 26 | Webhooks (aviso a un sistema externo al terminar de procesar un documento) | medio |
| 27 | Interfaz en varios idiomas (hoy solo español) | alto |

## Seguridad y operación
| # | Idea | Esfuerzo |
|---|---|---|
| 35 | Pruebas de extremo a extremo con Playwright: login, subir, preguntar, borrar. Hoy ninguna recorre la interfaz | alto |

## Si una de ellas se decide
Pasa a [pendientes.md](pendientes.md) con su número, y cuando se termine se tacha allí.
