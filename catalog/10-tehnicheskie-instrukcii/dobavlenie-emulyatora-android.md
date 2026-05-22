---
order: 1
title: Добавление Android-эмулятора
---

На платформе список виртуальных устройств для мобильных прогонов задаётся **только в манифесте** в репозитории приложения. После правок нужно перегенерировать артефакты и пересобрать Docker-образ фермы эмуляторов — тогда новый профиль появится в интерфейсе при создании окружения с **Operating System → Android**.

:::note

Инструкция рассчитана на инсталляцию, где сервисы поднимаются через `infra/docker-compose.services.yml`, как в [README](https://github.com/BugBuster-AI/bugbuster/blob/main/README.md) (Step 3 — Services). Все команды выполняйте из **корня репозитория `bugbuster`**.

Для ускоренной работы эмуляторов на Linux-хосте нужен доступ к **KVM** (`/dev/kvm`). В манифесте для профиля указывают `"passthrough_host_kvm": true`.

:::

## Что понадобится

1. Установленные **Docker** и **Docker Compose**.
2. На хосте Linux — доступ к **`/dev/kvm`** (см. раздел [Проверка доступа к KVM на хосте](#проверка-доступа-к-kvm-на-хосте)).
3. В `infra/services.env.example` включена локальная ферма: **`MOBILE_ANDROID_EMULATOR_ENABLED=1`** (значение по умолчанию).
4. Платформа уже хотя бы раз собрана по Step 3 из README — иначе сначала выполните базовую процедуру сборки сервисов.

## Проверка доступа к KVM на хосте

Контейнер **`android-emulator-farm`** пробрасывает **`/dev/kvm`** с хоста для аппаратного ускорения эмулятора. Если устройства нет или у Docker нет к нему доступа, ферма может не стартовать или работать крайне медленно. Проверку выполняйте **на машине, где запускается Docker**, до сборки и перезапуска сервисов.

### 1. Убедитесь, что процессор поддерживает виртуализацию

```bash
grep -E '(vmx|svm)' /proc/cpuinfo
```

Команда должна вывести хотя бы одну строку: **vmx** — Intel, **svm** — AMD. Пустой вывод означает, что виртуализация отключена в BIOS/UEFI или недоступна на этом железе (типично для некоторых VPS без nested virtualization).

### 2. Проверьте, что загружен модуль KVM

```bash
lsmod | grep kvm
```

Ожидаются строки с **`kvm`** и **`kvm_intel`** или **`kvm_amd`**. Если модулей нет, на Debian/Ubuntu можно установить поддержку:

```bash
sudo apt update
sudo apt install qemu-kvm
```

После установки перезагрузите хост или загрузите модуль вручную (`sudo modprobe kvm` и `kvm_intel` / `kvm_amd`).

### 3. Проверьте наличие и права на `/dev/kvm`

```bash
ls -l /dev/kvm
```

Устройство должно существовать. Типичные права: **`crw-rw----`**, владелец **`root`**, группа **`kvm`**.

Проверьте, что ваш пользователь входит в группу **`kvm`** (иначе Docker от имени этого пользователя не сможет открыть устройство):

```bash
groups
```

Если **`kvm`** в списке нет:

```bash
sudo usermod -aG kvm "$USER"
```

Затем **выйдите из сессии и войдите снова** (или перезагрузите хост), чтобы группа применилась. Повторите `groups` — **`kvm`** должна появиться.

### 4. Убедитесь, что устройство доступно для чтения и записи

```bash
test -r /dev/kvm && test -w /dev/kvm && echo "OK: /dev/kvm readable and writable"
```

Сообщение **`OK: /dev/kvm readable and writable`** подтверждает, что текущий пользователь может использовать KVM. Если команда ничего не выводит или выдаёт ошибку — вернитесь к шагу 3 (группа **`kvm`**, права на устройство).

На Ubuntu дополнительно можно запустить **`kvm-ok`** (пакет **`cpu-checker`**):

```bash
sudo apt install cpu-checker
kvm-ok
```

Ожидается ответ в духе **`KVM acceleration can be used`**.

### 5. Проверьте доступ из Docker

После шагов 1–4 контейнер фермы должен видеть KVM на хосте. Быстрая проверка до полной сборки:

```bash
docker run --rm --device /dev/kvm ubuntu:22.04 test -e /dev/kvm && echo "OK: Docker sees /dev/kvm"
```

Если вывод **`OK: Docker sees /dev/kvm`** — проброс устройства в **`android-emulator-farm`** с высокой вероятностью сработает. Ошибка **`permission denied`** или отсутствие **`/dev/kvm`** в контейнере — снова проверьте группу **`kvm`** и права на хосте; убедитесь, что Docker запускается от того же пользователя, для которого вы настраивали доступ.

:::note

На виртуальной машине (облачный VPS, VM внутри гипервизора) KVM часто **недоступен**, пока не включена вложенная виртуализация у провайдера. В таком случае эмулятор может работать только в программном режиме — это не рекомендуемый вариант для продакшена.

:::

## Как устроено

1. Источник правды — файл **`infra/mobile-service/mobile_profiles.manifest.json`**: массив `profiles` с параметрами каждого AVD.
2. Скрипт **`infra/scripts/render_mobile_stack.py`** читает манифест и создаёт артефакты в **`infra/mobile-service/compose-gen/`** (compose-фрагмент, registry профилей, скрипты сборки фермы).
3. Образ **`android-emulator-farm`** собирает AVD **на этапе build**; после добавления профиля его нужно **пересобрать**.
4. Backend отдаёт список профилей в UI через **`GET /api/environments/mobile_profiles`**. Названия и разрешения совпадают с **`mobile_profile_registry.json`** после генерации.

Один контейнер **Appium** обслуживает все профили; все эмуляторы живут в одном контейнере **android-emulator-farm** на разных adb-портах (5555, 5557, …).

## Добавить новый эмулятор

### 1. Откройте манифест

Файл: **`infra/mobile-service/mobile_profiles.manifest.json`**.

### 2. Добавьте профиль в массив `profiles`

Скопируйте блок ниже и вставьте **внутрь** массива `profiles` **после** существующей записи (не забудьте запятую между объектами). Значения **`executor_profile_id`** и **`avd_name`** должны быть **уникальными** среди всех профилей в файле.

```json
    {
      "profile_type": "avd_emulator",
      "executor_profile_id": "example-api33-tablet",
      "title": "Example Tablet API 33",
      "avd_name": "bb_example_api33_tablet",
      "system_image": "system-images;android-33;google_apis;x86_64",
      "display_width": 1200,
      "display_height": 1920,
      "passthrough_host_kvm": true
    }
```

Если манифест пустой или вы настраиваете стенд с нуля — можно **целиком** заменить содержимое файла на готовый пример с **двумя** эмуляторами:

```json
{
  "published_appium_port": 24723,
  "profiles": [
    {
      "profile_type": "avd_emulator",
      "executor_profile_id": "example-api34-phone",
      "title": "Example Phone API 34",
      "avd_name": "bb_example_api34",
      "system_image": "system-images;android-34;google_apis;x86_64",
      "display_width": 1080,
      "display_height": 1920,
      "passthrough_host_kvm": true
    },
    {
      "profile_type": "avd_emulator",
      "executor_profile_id": "example-api33-tablet",
      "title": "Example Tablet API 33",
      "avd_name": "bb_example_api33_tablet",
      "system_image": "system-images;android-33;google_apis;x86_64",
      "display_width": 1200,
      "display_height": 1920,
      "passthrough_host_kvm": true
    }
  ]
}
```

:::tip

Поля **`display_width`** и **`display_height`** можно не указывать — тогда генератор подставит **1080×1920**. Порт adb для второго и следующих профилей назначается автоматически (5557, 5559, …); переопределять его нужно только в нестандартных сценариях (`adb_port`, `emulator_console_port`).

:::

### 3. Сгенерируйте мобильный стек

Из корня **`bugbuster`**:

```bash
python3 infra/scripts/render_mobile_stack.py
```

Скрипт должен завершиться без ошибок. Проверьте, что появился или обновился каталог **`infra/mobile-service/compose-gen/`**, в том числе файл **`mobile_profile_registry.json`** — в нём должна быть запись с вашим **`executor_profile_id`** и полем **`adb_serial`** (например `android-emulator-farm:15557` для второго профиля).

### 4. Пересоберите образ фермы и перезапустите сервисы

Новый AVD создаётся при сборке образа **`android-emulator-farm`**. После генерации выполните:

```bash
docker compose -p services -f infra/docker-compose.services.yml --env-file infra/services.env.example build android-emulator-farm appium-android
docker compose -p services -f infra/docker-compose.services.yml --env-file infra/services.env.example up -d
```

Пересборка **`appium-android`** нужна, чтобы контейнер Appium получил обновлённый список adb-целей для всех профилей. Полная пересборка всех сервисов (`build` без имён образов) тоже допустима, но дольше по времени.

:::info

Первый запуск **`android-emulator-farm`** после добавления профиля может занять **десятки минут**: образ скачивает system image и создаёт AVD. Дождитесь статуса **healthy** у контейнера.

:::

### 5. Убедитесь, что профиль доступен в платформе

1. Откройте веб-интерфейс BugBuster и перейдите к созданию окружения (**Environments → + New Environment** или страница **`/environments/create`**).
2. В поле **Operating System** выберите **Android**.
3. В списке профилей эмулятора должны отображаться **`Example Phone API 34`** и **`Example Tablet API 33`** (или ваши значения поля **`title`** из манифеста), с разрешением из манифеста.
4. Выберите новый профиль, загрузите APK и сохраните окружение — прогоны с этим окружением пойдут на добавленный эмулятор.

При необходимости проверьте registry на хосте:

```bash
cat infra/mobile-service/compose-gen/mobile_profile_registry.json
```

В массиве **`profiles`** должны быть все **`executor_profile_id`** из манифеста.

## Типичные ошибки

**Дубликат `avd_name`.** Скрипт `render_mobile_stack.py` завершится с сообщением о повторяющемся имени AVD. Задайте каждому профилю уникальный **`avd_name`**.

**Профиль не появился в UI.** Убедитесь, что выполнены шаги 3–4, контейнеры **backend**, **clicker**, **appium-android** и **android-emulator-farm** в состоянии **Up**, а **`mobile_profile_registry.json`** содержит новую запись. Backend и clicker читают registry из смонтированного каталога **`compose-gen`**.

**Эмулятор долго не становится healthy.** Сначала выполните [проверку KVM на хосте](#проверка-доступа-к-kvm-на-хосте). Затем посмотрите логи контейнера:

```bash
docker logs android-emulator-farm --tail 100
```

**Неизвестный `executor_profile_id` при сохранении окружения.** Значение в UI не совпадает с registry — повторите генерацию и перезапуск сервисов после правки манифеста.

## Связанные материалы

- Настройка окружения с Android и загрузка APK в интерфейсе — см. [Настройка окружения](../04-peremennye-i-okruzheniya/nastroyka-okruzheniya.md) (раздел будет дополнен под Android; профиль выбирается после **Operating System → Android**).
- Базовая сборка всех сервисов — Step 3 в README репозитория **`bugbuster`**.
