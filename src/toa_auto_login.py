#!/usr/bin/env python3
"""Login automático no TOA via Selenium.
Usa selenium-manager (Selenium 4.x) para baixar o chromedriver compatível
automaticamente — sem depender de chromedriver.exe manual.
Monitor a cada 60s, reconecta após 2 falhas seguidas.
"""

import os
import sys
import time
import threading
import socket as _socket
import subprocess
import shutil

BOT_BUILD = os.getenv("BOT_BUILD", "v30")

TOA_USER      = os.getenv("TOA_USER", "Z478362")
TOA_PASS      = os.getenv("TOA_PASS", "Nc-09JR3")
TOA_LOGIN_URL = os.getenv("TOA_LOGIN_URL", "https://clarobrasil.etadirect.com/toa/")
LOGIN_TIMEOUT = int(os.getenv("TOA_LOGIN_TIMEOUT", "40"))
MAX_RETRIES   = int(os.getenv("TOA_LOGIN_RETRIES", "3"))
RETRY_DELAY   = int(os.getenv("TOA_RETRY_DELAY",   "8"))
HEADLESS_MODE = os.getenv("TOA_HEADLESS", "0") == "1"
MANUAL_LOGIN_GRACE = int(os.getenv("TOA_MANUAL_LOGIN_GRACE", "90"))
REQUIRE_EXTENSION = os.getenv("TOA_REQUIRE_EXTENSION", "1") == "1"


def log(msg: str):
    print(f"[{BOT_BUILD}] {msg}", flush=True)


def _get_win_host() -> str:
    try:
        with open("/etc/resolv.conf") as f:
            for line in f:
                if line.startswith("nameserver"):
                    return line.split()[1].strip()
    except Exception:
        pass
    return "172.22.176.1"


WIN_HOST = _get_win_host()


def _matar_chrome_e_driver():
    cmds = [
        "taskkill /F /IM chrome.exe /T >nul 2>&1",
        "taskkill /F /IM chromedriver.exe >nul 2>&1",
    ]
    for cmd in cmds:
        subprocess.Popen(
            ["cmd.exe", "/c", cmd],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    time.sleep(2)
    log("chrome/chromedriver antigos encerrados")


def _resolve_extension_path():
    primary_win = "C:\\Users\\Technet\\Downloads\\extensao_busca_contatos"
    primary_linux = "/mnt/c/Users/Technet/Downloads/extensao_busca_contatos"

    candidates = [
        (primary_win, primary_linux, "downloads"),
        ("\\\\wsl.localhost\\Ubuntu\\home\\technet\\qualquer\\extensao_busca_contatos", "/home/technet/qualquer/extensao_busca_contatos", "wsl-unc"),
    ]

    for ext_win, ext_linux, source in candidates:
        manifest = os.path.join(ext_linux, "manifest.json")
        if os.path.isdir(ext_linux) and os.path.exists(manifest):
            if source != "downloads":
                try:
                    if os.path.isdir(primary_linux):
                        shutil.rmtree(primary_linux, ignore_errors=True)
                    shutil.copytree(ext_linux, primary_linux)
                    return primary_win, primary_linux, f"{source}->downloads"
                except Exception as e:
                    log(f"Falha ao copiar extensão: {e}")
            return ext_win, ext_linux, source
    return None, None, None


def _build_options(use_profile: bool = True, use_extension: bool = True):
    from selenium.webdriver.chrome.options import Options

    options = Options()
    options.add_argument("--start-maximized")
    options.add_argument("--disable-notifications")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-session-crashed-bubble")
    options.add_argument("--disable-infobars")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.add_argument("--disable-gpu")
    options.add_argument("--remote-allow-origins=*")
    options.add_argument("--disable-blink-features=AutomationControlled")
    if HEADLESS_MODE:
        options.add_argument("--headless=new")

    options.binary_location = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"

    bot_profile_win   = "C:\\Users\\Technet\\AppData\\Local\\Google\\Chrome\\Bot"
    bot_profile_linux = "/mnt/c/Users/Technet/AppData/Local/Google/Chrome/Bot"
    os.makedirs(bot_profile_linux, exist_ok=True)
    if use_profile:
        options.add_argument(f"--user-data-dir={bot_profile_win}")
        log(f"Perfil: {bot_profile_win}")

    ext_win, ext_linux, ext_source = _resolve_extension_path()
    if use_extension and ext_win:
        options.add_argument(f"--disable-extensions-except={ext_win}")
        options.add_argument(f"--load-extension={ext_win}")
        log(f"Extensão: {ext_win} (origem: {ext_source})")
    elif use_extension:
        log("Extensão não encontrada")

    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    return options


def _iniciar_chromedriver_local(cd_path_win: str) -> bool:
    subprocess.Popen(
        ["powershell.exe", "-Command",
         f"Start-Process -FilePath '{cd_path_win}' "
         f"-ArgumentList '--port=19515 --whitelisted-ips=' -WindowStyle Hidden"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    log(f"chromedriver iniciado na porta 19515")
    for _ in range(20):
        try:
            s = _socket.create_connection((WIN_HOST, 19515), timeout=1)
            s.close()
            return True
        except Exception:
            time.sleep(0.5)
    log("Timeout esperando chromedriver")
    return False


def _criar_driver():
    try:
        from selenium import webdriver
    except ImportError:
        log("selenium não instalado: pip install selenium --break-system-packages")
        return None

    _matar_chrome_e_driver()

    cd_paths_win = [
        "C:\\Users\\Technet\\chromedriver.exe",
        "C:\\Users\\Technet\\chromedriver-win64\\chromedriver.exe",
        "C:\\chromedriver.exe",
    ]
    cd_paths_linux = [p.replace('C:\\', '/mnt/c/').replace('\\', '/') for p in cd_paths_win]

    cd_executavel = None
    for win_path, linux_path in zip(cd_paths_win, cd_paths_linux):
        if os.path.exists(linux_path):
            cd_executavel = win_path
            log(f"Chromedriver local: {linux_path}")
            break

    try:
        tentativas = [
            (True, True, "normal"),
            (False, True, "sem-perfil-com-ext"),
            (False, False, "sem-perfil-sem-ext"),
        ]
        if REQUIRE_EXTENSION:
            tentativas = [t for t in tentativas if t[1] is True]

        for use_profile, use_extension, nome in tentativas:
            log(f"Criando sessão Chrome ({nome})...")
            options = _build_options(use_profile=use_profile, use_extension=use_extension)
            driver = None

            if cd_executavel:
                if _iniciar_chromedriver_local(cd_executavel):
                    try:
                        driver = webdriver.Remote(
                            command_executor=f"http://{WIN_HOST}:19515",
                            options=options
                        )
                    except Exception as e:
                        log(f"Erro Remote: {e}")
                        driver = None
            else:
                log("Sem chromedriver local — tentando selenium-manager")
                try:
                    from selenium.webdriver.chrome.service import Service
                    driver = webdriver.Chrome(service=Service(), options=options)
                except Exception as e:
                    log(f"Erro selenium-manager: {e}")
                    driver = None

            if not driver:
                continue

            try:
                driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
                    "source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
                })
            except Exception:
                pass
            log("Driver Chrome criado com sucesso")
            return driver

        log("Falha em todos os modos")
        return None
    except Exception as e:
        log(f"Erro ao criar driver: {e}")
        return None


def _esperar_elemento(driver, by, selector, timeout=10):
    try:
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        return WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((by, selector)))
    except Exception:
        return None


def _find_visible_input(driver, selectors, timeout=12):
    from selenium.webdriver.common.by import By
    deadline = time.time() + timeout
    while time.time() < deadline:
        for selector in selectors:
            try:
                el = driver.find_element(By.XPATH, selector)
                if el and el.is_displayed():
                    return ("default", el)
            except Exception:
                pass
        time.sleep(0.4)
    return (None, None)


def _digitar_input(driver, elemento, valor: str) -> bool:
    from selenium.webdriver.common.keys import Keys
    if elemento is None:
        return False
    try:
        elemento.click()
        time.sleep(0.1)
        elemento.send_keys(Keys.CONTROL, "a")
        elemento.send_keys(Keys.BACKSPACE)
        elemento.send_keys(valor)
        return True
    except Exception:
        pass
    try:
        driver.execute_script(
            "arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event('input',{bubbles:true}));",
            elemento, valor
        )
        return True
    except Exception:
        return False


def _clicar_allow(driver, max_wait=8.0) -> bool:
    from selenium.webdriver.common.by import By
    deadline = time.time() + max_wait
    while time.time() < deadline:
        try:
            for btn in driver.find_elements(By.XPATH, '//button'):
                if (btn.text or "").strip() in ("Allow", "Permitir"):
                    driver.execute_script("arguments[0].click();", btn)
                    return True
        except Exception:
            pass
        try:
            ok = driver.execute_script("""
                function f(r){var b=r.querySelectorAll('button');for(var x of b){var t=x.textContent.trim();if(t==='Allow'||t==='Permitir'){x.click();return true;}}var e=r.querySelectorAll('*');for(var el of e){if(el.shadowRoot&&f(el.shadowRoot))return true;}return false;}return f(document);
            """)
            if ok:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _toa_aberto(driver) -> bool:
    def _url_valida(url):
        u = (url or "").lower()
        return "clarobrasil.etadirect.com" in u or "etadirect.com" in u
    try:
        if _url_valida(driver.current_url):
            return True
    except Exception:
        pass
    try:
        for handle in driver.window_handles:
            try:
                driver.switch_to.window(handle)
                if _url_valida(driver.current_url):
                    return True
            except Exception:
                continue
    except Exception:
        pass
    return False


def fazer_login(driver) -> bool:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.common.action_chains import ActionChains

    log("Navegando para URL de login...")
    try:
        driver.get(TOA_LOGIN_URL)
    except Exception as e:
        log(f"Erro ao abrir URL: {e}")
        return False
    time.sleep(4)

    if _clicar_allow(driver, max_wait=6):
        log("Popup Allow clicado")
        time.sleep(1)

    try:
        fechar = driver.find_element(By.XPATH,
            '//button[contains(text(),"×") or contains(text(),"✕") or contains(@aria-label,"fechar") or contains(@aria-label,"close")]')
        fechar.click()
        time.sleep(0.5)
    except Exception:
        pass

    try:
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
        time.sleep(0.5)
    except Exception:
        pass

    if _toa_aberto(driver):
        log("✅ Sessão restaurada pelo perfil — TOA já aberto!")
        time.sleep(3)
        _clicar_allow(driver, max_wait=15)
        return True

    _, campo_usuario = _find_visible_input(driver, [
        '//input[@name="username" or @id="username"]',
        '//input[contains(@placeholder,"suário") or contains(@placeholder,"sario")]',
        '//input[@type="email"]',
        '(//input[@type="text"])[1]'
    ], timeout=12)
    if not campo_usuario:
        log("❌ Campo USUÁRIO não encontrado")
        return False

    log("Digitando usuário...")
    if not _digitar_input(driver, campo_usuario, TOA_USER):
        return False
    time.sleep(0.3)

    _, campo_senha = _find_visible_input(driver, ['//input[@type="password"]'], timeout=10)
    if not campo_senha:
        log("❌ Campo SENHA não encontrado")
        return False

    log("Digitando senha...")
    if not _digitar_input(driver, campo_senha, TOA_PASS):
        return False
    time.sleep(0.3)

    btn = (
        _esperar_elemento(driver, By.XPATH, '//button[contains(translate(text(),"enviar","ENVIAR"),"ENVIAR")]', timeout=5)
        or _esperar_elemento(driver, By.XPATH, '//input[@type="submit"]', timeout=3)
        or _esperar_elemento(driver, By.XPATH, '//button[@type="submit"]', timeout=3)
    )
    if btn:
        log("Clicando ENVIAR...")
        try:
            driver.execute_script("arguments[0].click();", btn)
        except Exception:
            ActionChains(driver).move_to_element(btn).click().perform()
    else:
        log("Botão não encontrado — usando Enter")
        campo_senha.send_keys(Keys.RETURN)

    log(f"Aguardando TOA (máx {LOGIN_TIMEOUT}s)...")
    deadline = time.time() + LOGIN_TIMEOUT
    while time.time() < deadline:
        if _toa_aberto(driver):
            log("✅ Login bem-sucedido!")
            time.sleep(3)
            if _clicar_allow(driver, max_wait=20):
                log("✅ Popup Permitir clicado!")
            else:
                log("⚠️ Popup Permitir não apareceu")
            return True
        try:
            body = driver.find_element(By.TAG_NAME, "body").text
            if "System error" in body:
                log("⚠️ Erro de sistema")
                return False
        except Exception:
            pass
        time.sleep(1.5)

    log(f"⚠️ TOA não carregou em {LOGIN_TIMEOUT}s")
    return False


def aguardar_login_manual(driver, timeout=MANUAL_LOGIN_GRACE) -> bool:
    if timeout <= 0:
        return False
    log(f"⏳ Aguardando login manual por até {timeout}s...")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _toa_aberto(driver):
            log("✅ Login manual detectado!")
            return True
        time.sleep(1.5)
    log("⏱️ Tempo de login manual esgotado")
    return False


def login_com_retry():
    for tentativa in range(1, MAX_RETRIES + 1):
        log(f"Tentativa {tentativa}/{MAX_RETRIES}...")
        driver = _criar_driver()
        if not driver:
            if tentativa < MAX_RETRIES:
                time.sleep(RETRY_DELAY)
            continue
        try:
            if fazer_login(driver):
                return driver
            log(f"Login falhou na tentativa {tentativa}")
            if aguardar_login_manual(driver):
                return driver
            try: driver.quit()
            except Exception: pass
        except Exception as e:
            log(f"Erro tentativa {tentativa}: {e}")
            try: driver.quit()
            except Exception: pass
        if tentativa < MAX_RETRIES:
            log(f"Aguardando {RETRY_DELAY}s...")
            time.sleep(RETRY_DELAY)

    log("❌ Todas as tentativas falharam")
    return None


def monitorar(driver, intervalo=60):
    falhas = 0
    limite = 2

    def _loop():
        nonlocal driver, falhas
        while True:
            time.sleep(intervalo)
            try:
                if _toa_aberto(driver):
                    falhas = 0
                    continue
                falhas += 1
                log(f"⚠️ TOA não detectado ({falhas}/{limite})")
                if falhas < limite:
                    continue
                falhas = 0
                log("🔄 Reconectando TOA...")
                try: driver.quit()
                except Exception: pass
                novo = login_com_retry()
                if novo:
                    driver = novo
                    log("✅ Reconectado!")
                else:
                    log("❌ Falha ao reconectar")
            except Exception as e:
                log(f"Erro no monitor: {e}")

    t = threading.Thread(target=_loop, daemon=True)
    t.start()
    log(f"🔍 Monitor TOA iniciado (a cada {intervalo}s)")
    return t


def main() -> int:
    log("Iniciando login automático TOA...")
    driver = login_com_retry()
    if driver:
        log("TOA aberto. Monitorando...")
        monitorar(driver, intervalo=60)
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            log("Encerrando...")
            try: driver.quit()
            except Exception: pass
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
