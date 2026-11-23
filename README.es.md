<p align="center"><img src="./assets/logo.png" alt="Búho de Centinela" width="128" height="128"></p>

# Centinela

**Idioma:** Español · [English](./README.md)

Centinela le da una primera revisión amable a cada pull request e issue de un colaborador externo, para que llegue al mantenedor lista para revisar.
Publica un solo comentario en el idioma del autor (inglés o español), lo mantiene actualizado, etiqueta la contribución y define un estado del commit que puede bloquear el merge.
Un mantenedor revisa igualmente cada contribución.

## Qué revisa

| Área         | Pull request                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Descripción  | Título Conventional Commit y las secciones de su plantilla de pull request                                               |
| Evidencia    | Capturas para cambios de interfaz, pasos de reproducción para correcciones, pruebas para código nuevo                    |
| Tamaño       | Líneas cambiadas sin lockfiles ni archivos generados; a las pull requests grandes se les pide dividir                    |
| Idioma       | Errores de escritura en las líneas agregadas; opcionalmente el registro del español y la paridad de claves de traducción |
| Seguridad    | Workflows, lockfiles, licencias, scripts de instalación, binarios, Unicode oculto, secretos, bloques codificados         |
| Identidad    | Commits con la identidad de un mantenedor sin firma verificada                                                           |
| Dependencias | Dependencias npm nuevas, su licencia y hace cuánto se publicó la versión                                                 |

Los reportes de error necesitan pasos para reproducirlo, comportamiento esperado y actual, la versión y el sistema operativo.
Los reportes que parecen una vulnerabilidad se dirigen a su política de seguridad.

Los resultados se agrupan en tres: **para avanzar** (el autor lo corrige), **requiere revisión de un mantenedor** y **sugerencias**, que nunca bloquean.
El estado falla mientras alguno de los dos primeros grupos tenga puntos. La etiqueta `triage: approved` los acepta para el contenido actual: sigue valiendo en un commit nuevo con el mismo árbol (un squash o un mensaje reescrito) mientras la revisión no encuentre nada nuevo, y cualquier otro push necesita una aprobación nueva.

En una revisión posterior, los puntos que no estaban antes se marcan como **nuevo**, y el comentario indica cuántos de la revisión anterior quedaron resueltos.
Quien contribuye por primera vez recibe una bienvenida con el enlace a su guía de contribución: `CONTRIBUTING.md`, `.github/CONTRIBUTING.md` o `docs/CONTRIBUTING.md`, o la ruta en `links.contributing`.

## Cómo se mantiene seguro

- Se ejecuta con `pull_request_target` e `issues` y nunca descarga ni ejecuta el código contribuido. Lee la pull request solo mediante la API de GitHub.
- Lee su configuración desde la rama base, así que una pull request no puede cambiar sus propias reglas.
- Si la API devuelve un diff incompleto, falla de forma segura y pide un mantenedor.
- Revisa de nuevo solo cuando cambia algo que lee: un commit nuevo, el título, la descripción, las etiquetas de activación o aprobación, o sus reglas.

## Instalación

1. Copie [examples/centinela.yml](./examples/centinela.yml) en `.github/workflows/centinela.yml`.
2. Agregue `.github/centinela.json` con lo propio de su proyecto. Todas las claves son opcionales; vea [Configuración](#configuración).
3. Opcional, para publicar con el nombre y el avatar de Centinela: instale la GitHub App de Centinela en el repositorio y guarde sus credenciales.

   ```bash
   gh variable set CENTINELA_APP_CLIENT_ID --body <client-id>
   gh secret set CENTINELA_APP_PRIVATE_KEY < centinela.private-key.pem
   ```

   Sin ellas publica como `github-actions`.

4. Después de la primera ejecución, marque el estado `centinela` como chequeo obligatorio en las reglas de la rama.

Las contribuciones de mantenedores se omiten salvo que lleven la etiqueta `triage`. Los borradores y los bots se omiten.

## Configuración

`.github/centinela.json` se combina sobre [src/defaults.json](./src/defaults.json): los objetos se combinan clave por clave y las listas reemplazan la lista por defecto.
La excepción es `paths.sensitive`, que siempre conserva la base incluida (workflows, lockfiles, `CODEOWNERS`, licencias, política de seguridad, `.npmrc`).
La tabla de claves está en el [README en inglés](./README.md#configuration).

Las secciones obligatorias salen de su plantilla de pull request: una sección con un comentario que guía al autor es obligatoria, y las listas de verificación o secciones como Screenshots o Notes son opcionales. Se aceptan sinónimos (Verification o Checks llenan Testing) y títulos en español.

Centinela detecta el stack desde la rama base (Electron, React, servidor Node, Swift, Rust), activa las reglas de cada paquete y lo nombra en el pie del comentario. Además revisa siempre los workflows modificados.
Con `rules.custom` puede convertir las reglas de su `AGENTS.md` en chequeos; vea [Stack packs](./README.md#stack-packs) y [Project rules](./README.md#project-rules).

## Probar un cambio

Ejecútelo contra una pull request real sin publicar nada:

```bash
GITHUB_REPOSITORY=owner/repo GH_TOKEN=$(gh auth token) \
  node src/centinela.mjs --dry-run --force --pr 123 --config ruta/a/centinela.json
```

`npm test` ejecuta las pruebas. Centinela usa solo módulos nativos de Node.js.

## Versiones

Fije `johnny4young/centinela@v1` para la última versión compatible, o un SHA completo para revisar usted mismo cada actualización.
Una regla o un mensaje nuevo cambia la versión de las reglas, así que cada contribución abierta se revisa una vez más después de actualizar.

## Licencia

[MIT](./LICENSE)
