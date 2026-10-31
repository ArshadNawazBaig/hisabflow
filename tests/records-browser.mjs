import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:5173/',{waitUntil:'domcontentloaded'});
 await page.getByRole('heading',{name:'Welcome back.',exact:true}).waitFor();
 await page.locator('.top-navigation').getByRole('button',{name:'Companies',exact:true}).click();
 await page.getByRole('button',{name:'Add company',exact:true}).click();
 let modal=page.locator('.rv-modal');
 console.log('company labels',await modal.locator('label').allTextContents());
 await modal.locator('input[name="name"]').fill('QA Synthetic Customer');
 await modal.locator('select[name="role"]').selectOption('Customer');
 await modal.getByRole('button',{name:/Save company|Add company|Create company/}).click();
 await page.getByText('QA Synthetic Customer',{exact:true}).waitFor();
 await page.locator('.top-navigation').getByRole('button',{name:'Deliveries',exact:true}).click();
 await page.getByRole('button',{name:'Add delivery',exact:true}).click();modal=page.locator('.rv-modal');
 await modal.locator('select[name="companyId"]').selectOption({label:'QA Synthetic Customer · Customer'});
 await modal.locator('input[name="product"]').fill('QA material');
 await modal.locator('input[name="weight"]').fill('1.255');
 await modal.locator('input[name="rate"]').fill('100.10');
 assert.equal(await modal.locator('input[name="amount"]').inputValue(),'125.63');
 await modal.getByRole('button',{name:'Save delivery',exact:true}).click();
 await page.getByText('QA Synthetic Customer',{exact:true}).waitFor();
 await page.locator('.top-navigation').getByRole('button',{name:'Companies',exact:true}).click();
 const companyRow=page.locator('tr').filter({hasText:'QA Synthetic Customer'});
 assert.match(await companyRow.textContent(),/125\.63/);
 await page.locator('.top-navigation').getByRole('button',{name:'Payments',exact:true}).click();
 await page.getByRole('button',{name:/Record payment|Add payment/}).first().click();modal=page.locator('.rv-modal');
 console.log('payment labels',await modal.locator('label').allTextContents());
 await modal.locator('select[name="companyId"]').selectOption({label:'QA Synthetic Customer'});
 await modal.locator('input[name="actor"]').fill('QA Third-party Remitter');
 await modal.locator('input[name="amount"]').fill('25.63');
 await modal.locator('select[name="treatment"]').selectOption('Customer receipt');
 await modal.locator('input[name="reference"]').fill('QA-NON-NUMERIC');
 await modal.getByRole('button',{name:/Save payment/}).click();
 await page.getByText('QA Third-party Remitter',{exact:true}).first().waitFor();
 await page.locator('.top-navigation').getByRole('button',{name:'Companies',exact:true}).click();
 assert.match(await page.locator('tr').filter({hasText:'QA Synthetic Customer'}).textContent(),/100\.00/);
 await page.setViewportSize({width:390,height:844});
 for(const view of ['Overview','Companies','Deliveries','Payments','Imports','Reports']){
  await page.locator('.side-rail').getByRole('button',{name:view,exact:true}).click();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`mobile overflow in ${view}`);
 }
 assert.deepEqual(errors,[]);console.log('PASS company, decimal delivery, third-party payment, signed balance, six mobile views, no page errors');
}finally{await browser.close();}
