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

BOT_BUILD = os.getenv("BOT_BUILD", "v30")

TOA_USER      = os.getenv("TOA_USER", "z631404")
TOA_PASS      = os.getenv("TOA_PASS", "B@QkJtat93vG")
TOA_LOGIN_URL = os.getenv("TOA_LOGIN_URL", "https://clarobrasil.etadirect.com/toa/")
LOGIN_TIMEOUT = int(os.getenv("TOA_LOGIN_TIMEOUT", "40"))
MAX_RETRIES   = int(os.getenv("TOA_LOGIN_RETRIES", "3"))
RETRY_DELAY   = int(os.getenv("TOA_RETRY_DELAY",   "8"))


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
    """Mata chromedriver E chrome do perfil Bot para evitar conflito de sessão."""
    cmds = [
        "taskkill /F /IM chromedriver.exe >nul 2>&1",
    ]
    for cmd in cmds:
        subprocess.Popen(
            ["cmd.exe", "/c", cmd],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    time.sleep(2)
    log("chromedriver antigo encerrado")


def _criar_driver():
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
    except ImportError:
        log("selenium não instalado: pip install selenium --break-system-packages")
        return None

    # Sempre mata o antigo antes de criar novo
    _matar_chrome_e_driver()

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
    options.add_argument("--disable-software-rasterizer")
    options.add_argument("--disable-gpu-sandbox")
    options.add_argument("--headless=new")
    options.add_argument("--headless=new")
    options.add_argument("--disable-blink-features=AutomationControlled")

    # Caminho do Chrome no Windows
    chrome_bin = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    options.binary_location = chrome_bin

    # Perfil dedicado ao bot
    bot_profile_win   = "C:\\Users\\Technet\\AppData\\Local\\Google\\Chrome\\Bot"
    bot_profile_linux = "/mnt/c/Users/Technet/AppData/Local/Google/Chrome/Bot"
    os.makedirs(bot_profile_linux, exist_ok=True)
    #options.add_argument(f"--user-data-dir={bot_profile_win}")
    log(f"Perfil: {bot_profile_win}")

    # Extensão opcional
    ext_win   = "C:\\Users\\Technet\\Downloads\\extensao_busca_contatos"
    ext_linux = "/mnt/c/Users/Technet/Downloads/extensao_busca_contatos"
    if os.path.isdir(ext_linux):
        #options.add_argument(f"--load-extension={ext_win}")
        log(f"Extensão: {ext_win}")
    else:
        log(f"Extensão não encontrada (opcional): {ext_linux}")

    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)

    # Tenta chromedriver local primeiro, depois deixa selenium-manager resolver
    cd_paths_win   = [
        "C:\\Users\\Technet\\chromedriver.exe",
        "C:\\Users\\Technet\\chromedriver-win64\\chromedriver.exe",
        "C:\\chromedriver.exe",
    ]
    cd_paths_linux = [p.replace('C:\\', '/mnt/c/').replace('\\', '/') for p in cd_paths_win]

    cd_executavel = None
    for win_path, linux_path in zip(cd_paths_win, cd_paths_linux):
        if os.path.exists(linux_path):
            cd_executavel = win_path
            log(f"Chromedriver local encontrado: {linux_path}")
            break

    try:
        if cd_executavel:
            # Usa o chromedriver local via caminho Windows — precisa rodar no Windows
            # Converte para caminho que o Windows entende via powershell
            service = Service(executable_path=cd_executavel)
            # Para WSL conectando no Windows, usa Remote mesmo com chromedriver local
            # Inicia chromedriver manualmente e conecta via Remote
            _iniciar_chromedriver_local(cd_executavel)
            time.sleep(2)
            driver = webdriver.Remote(
                command_executor=f"http://{WIN_HOST}:19515",
                options=options
            )
        else:
            # Selenium-manager: baixa automaticamente o chromedriver correto
            # Mas como estamos no WSL apontando pro Chrome do Windows,
            # precisamos do chromedriver no Windows — usa Remote com selenium-manager
            log("Chromedriver local não encontrado — tentando via selenium-manager no Windows")
            driver = _criar_driver_via_powershell(options)
            if not driver:
                return None

        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
            "source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        })
        log("Driver Chrome criado com sucesso")
        return driver

    except Exception as e:
        log(f"Erro ao criar driver: {e}")
        return None


def _iniciar_chromedriver_local(cd_path_win: str) -> bool:
    """Inicia o chromedriver.exe no Windows via powershell."""
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


def _criar_driver_via_powershell(options):
    """
    Fallback: baixa chromedriver compatível via winget/curl no Windows e inicia.
    Para Chrome 134+, usa o endpoint oficial do Chrome for Testing.
    """
    from selenium import webdriver

    log("Baixando chromedriver compatível via Chrome for Testing...")
    script = r"""
$version = (Get-Item 'C:\Program Files\Google\Chrome\Application\chrome.exe').VersionInfo.FileVersion
$major = $version.Split('.')[0]
$url = "https://storage.googleapis.com/chrome-for-testing-public/$version/win64/chromedriver-win64.zip"
$dest = "C:\Users\Technet\chromedriver_dl.zip"
$outDir = "C:\Users\Technet\chromedriver-win64"
try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    Expand-Archive -Path $dest -DestinationPath $outDir -Force
    Write-Host "OK:$outDir\chromedriver-win64\chromedriver.exe"
} catch {
    Write-Host "ERRO:$_"
}
"""
    result = subprocess.run(
        ["powershell.exe", "-Command", script],
        capture_output=True, text=True, timeout=60
    )
    output = result.stdout.strip()
    log(f"Download resultado: {output}")

    if output.startswith("OK:"):
        cd_win = output[3:].strip()
        cd_linux = cd_win.replace('C:\\', '/mnt/c/').replace('\\', '/')
        if os.path.exists(cd_linux):
            if _iniciar_chromedriver_local(cd_win):
                try:
                    driver = webdriver.Remote(
                        command_executor=f"http://{WIN_HOST}:19515",
                        options=options
                    )
                    return driver
                except Exception as e:
                    log(f"Erro Remote após download: {e}")

    log("Não foi possível baixar chromedriver automaticamente")
    return None


def _esperar_elemento(driver, by, selector, timeout=10):
    try:
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        return WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((by, selector)))
    except Exception:
        return None


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
    try:
        for handle in driver.window_handles:
            try:
                driver.switch_to.window(handle)
                url = driver.current_url
                if "etadirect.com" in url or "clarobrasil" in url:
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

    # Clica Allow se aparecer
    if _clicar_allow(driver, max_wait=6):
        log("Popup Allow clicado")
        time.sleep(1)

    # Fecha popup restaurar páginas
    try:
        from selenium.webdriver.common.by import By as B
        fechar = driver.find_element(B.XPATH,
            '//button[contains(text(),"×") or contains(text(),"✕") or contains(@aria-label,"fechar") or contains(@aria-label,"close")]')
        fechar.click()
        time.sleep(0.5)
        log("Popup restaurar fechado")
    except Exception:
        pass

    try:
        driver.find_element("tag name", "body").send_keys(Keys.ESCAPE)
        time.sleep(0.5)
    except Exception:
        pass

    # Se sessão do perfil restaurou o TOA direto
    if _toa_aberto(driver):
        log("✅ Sessão restaurada pelo perfil — TOA já aberto!")
        time.sleep(3)
        _clicar_allow(driver, max_wait=15)
        return True

    # Campo usuário
    campo_usuario = (
        _esperar_elemento(driver, By.XPATH, '//input[@name="username" or @id="username"]', timeout=10)
        or _esperar_elemento(driver, By.XPATH, '//input[contains(@placeholder,"suário") or contains(@placeholder,"sario")]', timeout=5)
        or _esperar_elemento(driver, By.XPATH, '//input[@type="text"][1]', timeout=5)
    )
    if not campo_usuario:
        log("❌ Campo USUÁRIO não encontrado")
        try:
            log(f"URL atual: {driver.current_url}")
        except Exception:
            pass
        return False

    log("Digitando usuário...")
    campo_usuario.clear()
    campo_usuario.click()
    time.sleep(0.3)
    campo_usuario.send_keys(TOA_USER)
    time.sleep(0.5)

    # Campo senha
    campo_senha = _esperar_elemento(driver, By.XPATH, '//input[@type="password"]', timeout=8)
    if not campo_senha:
        log("❌ Campo SENHA não encontrado")
        return False

    log("Digitando senha...")
    campo_senha.clear()
    campo_senha.click()
    time.sleep(0.3)
    campo_senha.send_keys(TOA_PASS)
    time.sleep(0.5)

    # Botão enviar
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

    # Aguarda TOA carregar
    log(f"Aguardando TOA (máx {LOGIN_TIMEOUT}s)...")
    deadline = time.time() + LOGIN_TIMEOUT
    while time.time() < deadline:
        if _toa_aberto(driver):
            log("✅ Login bem-sucedido!")
            time.sleep(3)
            if _clicar_allow(driver, max_wait=20):
                log("✅ Popup Permitir clicado!")
            else:
                log("⚠️ Popup Permitir não apareceu (pode já estar permitido)")
            return True
        try:
            body = driver.find_element("tag name", "body").text
            if "System error" in body:
                log("⚠️ Erro de sistema detectado")
                return False
        except Exception:
            pass
        time.sleep(1.5)

    log(f"⚠️ TOA não carregou em {LOGIN_TIMEOUT}s")
    try:
        log(f"URL atual: {driver.current_url}")
    except Exception:
        pass
    return False


def login_com_retry():
    for tentativa in range(1, MAX_RETRIES + 1):
        log(f"Tentativa {tentativa}/{MAX_RETRIES}...")
        driver = _criar_driver()
        if not driver:
            log(f"Falha ao criar driver na tentativa {tentativa}")
            if tentativa < MAX_RETRIES:
                time.sleep(RETRY_DELAY)
            continue
        try:
            if fazer_login(driver):
                return driver
            log(f"Login falhou na tentativa {tentativa}")
            try: driver.quit()
            except Exception: pass
        except Exception as e:
            log(f"Erro tentativa {tentativa}: {e}")
            try: driver.quit()
            except Exception: pass
        if tentativa < MAX_RETRIES:
            log(f"Aguardando {RETRY_DELAY}s antes da próxima tentativa...")
            time.sleep(RETRY_DELAY)

    log("❌ Todas as tentativas falharam")
    return None


def monitorar(driver, intervalo=60):
    falhas = 0
    LIMITE = 2

    def _loop():
        nonlocal driver, falhas
        while True:
            time.sleep(intervalo)
            try:
                if _toa_aberto(driver):
                    falhas = 0
                    continue
                falhas += 1
                log(f"⚠️ TOA não detectado ({falhas}/{LIMITE})")
                if falhas < LIMITE:
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