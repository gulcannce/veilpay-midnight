# VeilPay

VeilPay, Midnight üzerinde alışveriş harcamalarını gizli bir bütçeye göre kontrol eden bir ödeme politikasıdır. Kullanıcı bütçesini açıklamadan bir satın alma tutarının izinli olup olmadığını kanıtlar; satıcı ve zincir yalnızca politikanın etkin olduğunu ve harcamanın kabul veya reddedildiğini görür.

## Gizlilik modeli

- **Public ledger:** `policyVersion`, sözleşmenin etkin bir politika sürümüne sahip olduğunu gösteren zincir üstü metadatadır.
- **Private witness:** `getPrivateBudget()` kullanıcının yerel bütçesini sağlar. Bütçe sözleşme ledger’ına yazılmaz ve ağa gönderilmez.
- **Bilinçli açıklama:** `disclose(policyVersion >= 1 && price <= budget)` yalnızca harcamanın izinli olup olmadığını açıklar. Kaynak sözleşme fiyatı veya bütçeyi açıkça `disclose` etmez ve bunları ledger’da saklamaz.

## Gereksinimler

- Node.js 22 (`.nvmrc` ile sabitlenmiştir)
- Docker Desktop
- Compact toolchain 0.31.1

Apple Silicon macOS’ta Node 22 kurulumu:

```bash
brew install node@22
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node --version
```

Compact sürümünü doğrulayın:

```bash
compact compile --version
# 0.31.1
```

## Yerelde çalıştırma

```bash
npm ci
npm run compile
npm test
```

Yerel veya uzak ağdaki kanıtlar için proof server başlatın:

```bash
npm run proof-server
```

Başarılı derleme aşağıdaki çıktıları üretir:

- `contracts/managed/spending_policy/contract/`: yönetilen JavaScript sözleşmesi
- `contracts/managed/spending_policy/zkir/`: `canSpend` devreleri
- `contracts/managed/spending_policy/keys/`: prover ve verifier anahtarları

Test paketi üç davranışı doğrular: bütçe içi harcama kabul edilir, bütçe aşımı reddedilir ve public politika devre dışıysa harcama reddedilir.

## Preview / Preprod dağıtımı

Dağıtımdan önce Node 22, Docker, çalışır bir proof server ve Preview/Preprod için fonlanmış bir Midnight cüzdanı gerekir. Bu depo derleme için gerekli `zkir` ve anahtar materyalini içerir. Dağıtım tamamlanınca aşağıdaki alanları gerçek değerlerle güncelleyin ve iki ekran görüntüsünü depoya ekleyin:

```text
Network: <Preview veya Preprod>
Contract address: <yayınlanan adres>
Deployment transaction: <işlem kimliği>
```

Gönderim kanıtı olarak derleme terminali ekran görüntüsünde `canSpend` devresi ve `keys/` çıktısı; dağıtım ekran görüntüsünde ise ağ ile sözleşme adresi görünmelidir.

## Proje yapısı

```text
contracts/spending_policy.compact       Compact kaynak sözleşmesi
contracts/managed/spending_policy/      Derlenmiş sözleşme, devreler ve anahtarlar
src/midnight/spending-policy.test.ts    Devre davranış testleri
```
