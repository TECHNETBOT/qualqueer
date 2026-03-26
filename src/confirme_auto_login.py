#!/usr/bin/env python3
"""
Abre o Confirme Online automaticamente e mantém a sessão viva.
Na primeira vez: faz login e aguarda o usuário clicar no reCAPTCHA manualmente.
Depois: fica vivo clicando em algo leve a cada X minutos para não deslogar.
"""

import os
import sys
import time
import threading

BOT_BUILD = os.getenv("BOT_BUILD", "v30")

# ── Credenciais ───────────────────────────────────────────────────────────────
CONFIRME_USER = os.getenv("CONFIRME_USER", "DMVDI00008")
CONFIRME_PASS = os.getenv("CONFIRME_PASS", "Dmv@2020")
CONFIRME_LOGIN_URL = "https://consulta5.confirmeonline.com.br/validarLogin/confirmeOnline.xhtml"
CONFIRME_MAIN_URL  = "https://consulta5.confirmeonline.com.br/siteconfirmeonline/faces/main.xhtml"

# Keepalive: clica a cada X segundos para não deslogar por inatividade
KEEPALIVE_INTERVAL = int(os.getenv("CONFIRME_KEEPALIVE_INTERVAL", "120"))  # 2 min
LOGIN_TIMEOUT      = int(os.getenv("CONFIRME_LOGIN_TIMEOUT", "600"))        # 10 min — tempo sobra pra resolver captcha
MAX_RETRIES        = int(os.getenv("CONFIRME_LOGIN_RETRIES", "3"))
RETRY_DELAY        = int(os.getenv("CONFIRME_RETRY_DELAY", "5"))


def log(msg: str):
    print(f"[CONFIRME/{BOT_BUILD}] {msg}", flush=True)


def _get_driver():
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
    except ImportError:
        log("selenium não instalado. Rode: pip install selenium --break-system-packages")
        return None

    options = Options()
    options.add_argument("--start-maximized")
    options.add_argument("--disable-notifications")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-session-crashed-bubble")
    options.add_argument("--disable-infobars")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")

    # Chrome do Windows (mesmo padrão do TOA)
    options.binary_location = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    log("Usando Chrome do Windows")

    # Perfil dedicado para o Confirme (separado do TOA)
    bot_profile_win   = "C:\\Users\\Technet\\AppData\\Local\\Google\\Chrome\\BotConfirme"
    bot_profile_linux = "/mnt/c/Users/Technet/AppData/Local/Google/Chrome/BotConfirme"
    os.makedirs(bot_profile_linux, exist_ok=True)
    options.add_argument(f"--user-data-dir={bot_profile_win}")
    log(f"Perfil: {bot_profile_win}")

    # Extensão do Confirme Online
    ext_win   = "C:\\Users\\Technet\\Downloads\\extensao-confirme"
    ext_linux = "/mnt/c/Users/Technet/Downloads/extensao-confirme"
    if os.path.isdir(ext_linux):
        options.add_argument(f"--load-extension={ext_win}")
        log(f"Extensão carregada: {ext_win}")
    else:
        log(f"Extensão não encontrada em {ext_linux} — continuando sem ela")

    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)

    try:
        from selenium.webdriver.chrome.service import Service
        import subprocess, socket

        CDPORT = 19516  # porta diferente do TOA (que usa 19515)

        def _get_win_host():
            try:
                with open("/etc/resolv.conf") as f:
                    for line in f:
                        if line.startswith("nameserver"):
                            return line.split()[1].strip()
            except Exception:
                pass
            return "172.22.176.1"

        WIN_HOST = _get_win_host()
        log(f"Windows host IP: {WIN_HOST}")

        # Mata instância anterior do chromedriver na porta 19516
        subprocess.Popen(
            ["powershell.exe", "-Command",
             f"Get-NetTCPConnection -LocalPort {CDPORT} -ErrorAction SilentlyContinue | "
             f"Select-Object -ExpandProperty OwningProcess | "
             f"ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        time.sleep(0.5)

        # Inicia chromedriver.exe na porta dedicada
        subprocess.Popen(
            ["powershell.exe", "-Command",
             f"Start-Process -FilePath 'C:\\Users\\Technet\\chromedriver.exe' "
             f"-ArgumentList '--port={CDPORT} --whitelisted-ips=' -WindowStyle Hidden"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        log(f"chromedriver iniciado na porta {CDPORT}")

        # Aguarda chromedriver ficar disponível
        for _ in range(20):
            try:
                s = socket.create_connection((WIN_HOST, CDPORT), timeout=1)
                s.close()
                break
            except Exception:
                time.sleep(0.5)
        else:
            log("Timeout esperando chromedriver")
            return None

        driver = webdriver.Remote(
            command_executor=f"http://{WIN_HOST}:{CDPORT}",
            options=options
        )
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
            "source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        })
        return driver
    except Exception as e:
        log(f"Erro ao iniciar Chrome: {e}")
        return None


def _esperar_elemento(driver, by, selector, timeout=10):
    try:
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        return WebDriverWait(driver, timeout).until(
            EC.element_to_be_clickable((by, selector))
        )
    except Exception:
        return None


def fazer_login(driver) -> bool:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys

    log("Abrindo Confirme Online...")
    driver.get(CONFIRME_LOGIN_URL)
    time.sleep(3)

    # Campo usuário
    campo_user = (
        _esperar_elemento(driver, By.XPATH, '//input[@name="j_username" or @id="j_username"]', timeout=10)
        or _esperar_elemento(driver, By.XPATH, '//input[@type="text"][1]', timeout=5)
    )
    if not campo_user:
        log("❌ Campo usuário não encontrado")
        return False

    log("Digitando usuário...")
    campo_user.clear()
    campo_user.click()
    time.sleep(0.3)
    campo_user.send_keys(CONFIRME_USER)
    time.sleep(0.4)

    # Campo senha
    campo_senha = _esperar_elemento(driver, By.XPATH, '//input[@type="password"]', timeout=8)
    if not campo_senha:
        log("❌ Campo senha não encontrado")
        return False

    log("Digitando senha...")
    campo_senha.clear()
    campo_senha.click()
    time.sleep(0.3)
    campo_senha.send_keys(CONFIRME_PASS)
    time.sleep(0.4)

    log("=" * 55)
    log("⚠️  AÇÃO MANUAL NECESSÁRIA:")
    log("   1. Resolva o reCAPTCHA (pode ter imagens pra selecionar)")
    log("   2. Clique em 'Acesse o Sistema'")
    log(f"  Você tem {LOGIN_TIMEOUT // 60} minutos — sem pressa!")
    log("=" * 55)

    # Fica esperando o usuário logar — sem intervir
    # Só monitora a URL para detectar quando entrou
    deadline = time.time() + LOGIN_TIMEOUT
    ultimo_aviso = time.time()
    while time.time() < deadline:
        try:
            url = driver.current_url
            if "main.xhtml" in url or ("siteconfirmeonline" in url and "validarLogin" not in url):
                log("✅ Login detectado! Confirme Online carregado.")
                time.sleep(2)
                return True
        except Exception:
            pass

        # Avisa no terminal a cada 60s só pra saber que ainda está esperando
        if time.time() - ultimo_aviso >= 60:
            restante = int((deadline - time.time()) / 60)
            log(f"Ainda aguardando login... ({restante} min restantes)")
            ultimo_aviso = time.time()

        time.sleep(2)

    log(f"⚠️  Login não concluído após {LOGIN_TIMEOUT // 60} minutos")
    return False


def verificar_confirme_ativo(driver) -> bool:
    """Retorna True se o Confirme Online está aberto e logado."""
    try:
        url = driver.current_url
        return "confirmeonline.com.br" in url and "validarLogin" not in url
    except Exception:
        return False


def keepalive(driver):
    """
    Mantém a sessão viva clicando em algo leve periodicamente.
    Estratégia: hover no menu ou clique na aba CPF/CNPJ (sem fazer busca).
    """
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.action_chains import ActionChains

    try:
        # Tenta hover no logo ou no menu principal — não dispara nenhuma ação
        el = driver.find_element(By.XPATH, '//img[contains(@src,"logo")] | //div[@class="logo"] | //a[@href="#"]')
        if el:
            ActionChains(driver).move_to_element(el).perform()
            log("keepalive: hover no logo")
            return
    except Exception:
        pass

    try:
        # Alternativa: clica na aba CPF/CNPJ (sempre presente no menu)
        aba = driver.find_element(By.XPATH, '//a[contains(text(),"CPF") or contains(text(),"CNPJ")]')
        driver.execute_script("arguments[0].click();", aba)
        log("keepalive: clicou na aba CPF/CNPJ")
        return
    except Exception:
        pass

    try:
        # Último recurso: executa JS mínimo para manter a sessão
        driver.execute_script("document.title = document.title;")
        log("keepalive: JS title touch")
    except Exception:
        log("keepalive: falhou")


def monitorar_e_reconectar(driver_ref: list, intervalo: int = 30):
    """
    Thread que monitora se o Confirme ainda está ativo.
    Faz keepalive a cada KEEPALIVE_INTERVAL segundos.
    Reconecta se detectar logout.
    """
    ultimo_keepalive = time.time()

    def _loop():
        nonlocal ultimo_keepalive
        driver = driver_ref[0]
        while True:
            time.sleep(intervalo)
            try:
                agora = time.time()

                # Keepalive periódico
                if agora - ultimo_keepalive >= KEEPALIVE_INTERVAL:
                    if verificar_confirme_ativo(driver):
                        keepalive(driver)
                        ultimo_keepalive = agora
                    else:
                        log("🔄 Confirme caiu! Reconectando...")
                        try: driver.quit()
                        except Exception: pass
                        novo = login_com_retry()
                        if novo:
                            driver_ref[0] = novo
                            driver = novo
                            ultimo_keepalive = time.time()
                            log("✅ Reconectado ao Confirme Online!")
                        else:
                            log("❌ Falha ao reconectar. Tentando na próxima rodada.")
            except Exception as e:
                log(f"Erro no monitoramento: {e}")

    t = threading.Thread(target=_loop, daemon=True)
    t.start()
    log(f"Monitoramento Confirme iniciado (keepalive a cada {KEEPALIVE_INTERVAL}s, check a cada {intervalo}s)")
    return t


def login_com_retry():
    for tentativa in range(1, MAX_RETRIES + 1):
        log(f"Tentativa de login {tentativa}/{MAX_RETRIES}...")
        driver = _get_driver()
        if not driver:
            log("Não foi possível criar driver Chrome.")
            return None
        try:
            ok = fazer_login(driver)
            if ok:
                return driver
            log(f"Login falhou na tentativa {tentativa}.")
            try: driver.quit()
            except Exception: pass
        except Exception as e:
            log(f"Erro na tentativa {tentativa}: {e}")
            try: driver.quit()
            except Exception: pass

        if tentativa < MAX_RETRIES:
            log(f"Aguardando {RETRY_DELAY}s...")
            time.sleep(RETRY_DELAY)

    log("❌ Todas as tentativas de login falharam.")
    return None


def main() -> int:
    log("Iniciando Confirme Online automático...")
    driver = login_com_retry()
    if driver:
        log("✅ Confirme Online aberto. Monitorando sessão...")
        driver_ref = [driver]
        monitorar_e_reconectar(driver_ref, intervalo=30)
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            log("Encerrando...")
            driver_ref[0].quit()
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())