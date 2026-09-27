/**
 * Invoice PDFs in Google Drive:  <folder of the Sheet>/Sales_Invoices/FY 2026-27/09/GST/GF-26-27-00001.pdf
 *   - GST folder = bills printed as TAX INVOICE (GST shown and the shop's GSTIN set); the rest go to Non-GST,
 *     so the accountant can take just the GST folder;
 *   - made here on the server from the saved bill (the phone only asks), so the app stays light;
 *   - every night at 2 am a timer saves PDFs for the day's bills and credit notes (checkout is never slowed down);
 *   - "Save PDF to Drive" on a bill does it at once; a voided bill's PDF is renamed …-VOID.pdf.
 * Files stay private to the shop account.
 */

const PDF_FN_ = "savePendingInvoicePdfs";
const PDF_ROOT_ = "Sales_Invoices";
const PDF_VOID_MARK_ = "#void"; // appended to pdf_url once the file carries the -VOID name

function pdfName_(docNo, voided) {
    return String(docNo).replace(/[\/\\]/g, "-") + (voided ? "-VOID" : "") + ".pdf";
}

function pdfFileId_(url) {
    const m = /\/d\/([A-Za-z0-9_-]+)/.exec(String(url || "")) || /[?&]id=([A-Za-z0-9_-]+)/.exec(String(url || ""));
    return m ? m[1] : "";
}

/**
 * Folders are found by name every run, never remembered by id between runs. A Drive folder keeps its
 * id through a rename and a move, so remembering ids meant the app silently followed a folder someone
 * had renamed or filed elsewhere instead of rebuilding the expected path. Within one run the timer may
 * write many PDFs, and they share these lookups.
 */
let PDF_DIRS_ = {};

// Sales_Invoices inside the folder that holds the Sheet (My Drive root if it isn't in a folder)
function invoiceRoot_() {
    if (PDF_DIRS_.root) return PDF_DIRS_.root;
    const parents = DriveApp.getFileById(ss_().getId()).getParents();
    const home = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
    return (PDF_DIRS_.root = subFolder_(home, PDF_ROOT_));
}

// "FY 2026-27" — April to March, like the invoice numbers (GF/26-27/…)
function fyFolderName_(dateStr) {
    const y = parseInt(String(dateStr).slice(0, 4), 10);
    const start = parseInt(String(dateStr).slice(5, 7), 10) >= 4 ? y : y - 1;
    return "FY " + start + "-" + pad_((start + 1) % 100, 2);
}

function subFolder_(parent, name) {
    const it = parent.getFoldersByName(name);
    return it.hasNext() ? it.next() : parent.createFolder(name);
}

// a bill is a tax invoice when it shows GST and the shop has a GSTIN — the same rule as the PDF's title
function isTaxInvoice_(sale) {
    return !!sale && !sale.gst_hidden && !!str_(setting_("gstin"));
}

// Sales_Invoices/FY 2026-27/09/GST — every level is made on the first bill that needs it
function invoiceFolder_(dateStr, gst) {
    const date = String(dateStr || todayStr_());
    const kind = gst ? "GST" : "Non-GST";
    const key = date.slice(0, 7) + "|" + kind;
    if (PDF_DIRS_[key]) return PDF_DIRS_[key];
    const month = subFolder_(subFolder_(invoiceRoot_(), fyFolderName_(date)), date.slice(5, 7));
    return (PDF_DIRS_[key] = subFolder_(month, kind));
}

/**
 * PDFs saved before the FY layout sit in Sales_Invoices/yyyy-MM. Move them into FY …/MM (same file ids,
 * so every link on a bill keeps working) and bin the empty old folder. Time-boxed; the next run continues.
 */
function migratePdfFolders_(inTime) {
    const folders = invoiceRoot_().getFolders();
    let moved = 0;
    while (folders.hasNext() && inTime()) {
        const old = folders.next();
        if (!/^\d{4}-\d{2}$/.test(old.getName())) continue;
        const target = subFolder_(subFolder_(invoiceRoot_(), fyFolderName_(old.getName() + "-01")), old.getName().slice(5, 7));
        const files = old.getFiles();
        while (files.hasNext() && inTime()) {
            files.next().moveTo(target);
            moved++;
        }
        if (!old.getFiles().hasNext() && !old.getFolders().hasNext()) old.setTrashed(true);
    }
    return moved;
}

function makePdf_(html, name, folder) {
    const pdf = Utilities.newBlob(html, "text/html", name.replace(/\.pdf$/, ".html")).getAs("application/pdf").setName(name);
    return folder.createFile(pdf).getUrl();
}

function trashPdf_(url) {
    try {
        DriveApp.getFileById(pdfFileId_(url)).setTrashed(true);
    } catch (e) {
        console.warn("trashPdf_", e);
    }
}

/* ---------- document HTML (tables + inline styles: Google's PDF converter ignores flex/grid) ---------- */

const PDF_MONTHS_ = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PDF_LOGO_ = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAACXBIWXMAADsOAAA7DgHMtqGDAAAdmElEQVR4nO1dCZgdRbWuVzVLkklmSQKygwoKiLIvEllkC0IAWYIIhEUWEQRcwT2giCGyhC0QBDXgRmQPJITJrZoA6kNARcDlPTeeawhkm6oBn36W398zbXp6qu/tvlv1vfec7/u/ZGa6q2s5p+rUqVPnMEZUFbLLWNdgof1tWokZRvELjRJzjBJ3aMnv15I/bpR4UUvxOyPFakAroY0SFgj+H/4ezwTP8sfxrlHi9uGy+IUoG9/At3y3l6hFyf6QjTeqbQ8t+VlaiXlGcmmkeDlk5jpipVG8gDqgLqgT6ua7f4iajLRim5gBcRRmYa34k1qJ1z0weypoKf6B1cMosUAX+GmvKbaN7/4jajCyio0bVOKQEbXjGd9MXbFQKPFbCASEGG3z3b9EOaQ1ivVqxc8wij+slTC+mbaGwmCM5IuxOqzuZz2++53II1nFJg5KfoqW/KE8qzU1FIbXteIPDhb4ybSpbiGCFWXEQvOqbybMEdYFapJs3933+BDVynIj+blG8WdzwGw5B39GK34O7ReagNY/zjbSkl+qlfizf8ZqMMjAtDvHPMY28z2ORBlpqMC21krcqqV4zTsjNTi0FENaivlDK9iWvseVqAQNLmMbB/Z6YvzqC4ISfw/2CbQi5I/WPsomaymuJcavgyBIMWSUuHrtE6zP97i3PFnF2oLNrR9XhFbHq0byizEGvvmgJUkXxGEjx/6+GaG1IfnzODn3zQ+tpedLcaf3gSfYKLQUi2B1880fTU1DA2KmkWKV78EmCDcCl25+rrXsv3zzSlORWc42N4o/6n2ACTadIPClZC2qEpkBcaxR4hXvg0qw2YRArBlS/CTf/NPQ7gtaieu9DyTBVigId8Lx0Dc/NRStH2A7GCl+6X3wCLZKeHFdgb3VN181BJmCONoosTYHg0ZQVYQU640SJ/jmr9ySXcTEiBvDv7wPFsHWAsHYSnElxto3v+WKcCEDF1N8DxBB1AeSL131JJvkm+9yQXoF27QZ7t4SREbwnxnFtmCtTIOqfSetxEv+B4NgPEAr8Yf1y9mOrBUJcWzIvk8wUqwxqm0f1ko0VGjbf+Qeqv8BIFjf0FIMDhbEQawVSCtx+IhPufeOJ4hchWzRUkxnTc/8LRiChCDSh2opiMNYM9KQbJsWDQhLIBgHoB0MybYDWDORkW17j5wEeu9gQkNgnRlo25M1i6kz8BP336mExsKrDW8ixSEXbL056ExCA0JL8XtE52aNSPYhNkEr/pTvTiQ0OvgzDRe7NHBsk3yx/84jNAO04g/Y2YyzRiGjxFW+O43QdLiCNQIZKY4hl2aCqY0r9fEsz4RbP+TiQDC1ghTrcVuQ5ZFw75OuMRJMzcFfgIGF5Y1G0nnmoIMIzQ4txXyWw9Al3juG0EIoiKNZHggBkMivn2DqDSlW4aDVN/8zithGMN7AH/HK/Fry0/13AqGVMVjgJ3th/vWKTaW4/ATjG1Ks8hKVWkvxXe+NJxBUgIU+klP4bjSBYEPU7U7xSFqi5303mEAwo/FiXdI1GckvykFjCQQ7Fvy8mjI/MgOSzZ9g8otXkTG0ZgKAVKQ5aCSBYBMhxdzaXW+keD4ElW8EPFqL9ExaiZt9N45AMCmglZhXVeYf6mdbUUArgmkQgFeHVrAtqyYAWolbfTeKQDAZoJW4qWqJqUn3J5gGjDUKd52KBcAocbnvxhAIpgxoxT9fEfNbxcYZJf7muyEEgikPK5Fut/zZX/Jzc9AIAsGWC6342eULgOLP+m4AgWAqgJb86UpSGHlvAIFgKoQeaN+1DAEQC3xXnEAwPkyiCEZKAa4IpnmwNlMsoUHFT81BpQkEWy0MSf6+9OoPRXYmqOaClvy+VMy/RrFe8vshmCaDluK11f2sp6QAaMXP9F1ZAsFkwPqCsIWbO+3Nl3QFkPM7g9/Fn4NqX1r9Ufxh3w0iEExKPHlbhz1gzz77oZmT7Nc+O8He9pkJ9rwTJtkD9+yzP/hax5hEGyVdH+BE5LtRBILJwPy/+N5oRgde/G6H3X+PPvvDiBAgTa9dwjqT1R8ppvtuFIFgUgAqzoEJzB/ihe902Hfv1YeQKenCp+Amje+GEQgmBaDnQ+25Z854e8ZR3fbc47vtd7403p5waI9dt1wEv3tiQYc974RuO3BLZ7o7w0aJX/luGIFgUgCbXej8+P/cC7vsYzd02h/d3mF33n6y/fYXx9tddphsH7p6XLAnuPmS4ecCSP58sTDn3htGIJiUAgDmjgsAZvzd39YX/AsBWPDpmAAEewFH7uGhAj/Rd6MIBJNBBYK1B/8Hkz++oNP+ZGGHveVTE+z0fXvtty4fb/tv7LQfPD6mAgED4ljS/wm2GTbBsPYkPfO8YxM8gqsdFiD+tO9GEQgmA2Dn32/3vsDaE/8bfhc3g4bQkv9oFPPj2piW4v9rUUkthX12YYe9+8rxdv6lE+xXLphor/lIl/3mFyYEOtuafv8dWS7QLiy1N3yiy17+wS477+Nd9q7Lxtv/vqPDNetUhNWPtQV6LvoNOu+XzsOp5wT7/a+Mt7+5p917XxiPQoBZHjo/VKHhg7Bue9DefQF/ud7RSvwdZ14bNsDL2/aqdsWe+npHYJra/s2T7dSpUxPxxq2m2ItOmhTocEuuG2f3enuf/fQZE8eU9+fFbXa3HfvKwrt267NHHdgbfGfh7An2pQfKZ5hf3t1hP3rKJLvjdsXbtd0bJwc66k8WVsac6JOZh/bYLTabUvR7++zSZ+d8eKL9y+I2Zzlr+0Xmfrv09LHj8Mqy8sehGH5192hm/dND7SXfueJDXcGzmGyg54euEOClkhOQbN89ov/zs6vF+P/z/XZ74mE9dqONNgzOGzaeGjDDo/M6AwaC3oYd+lnv7bYbR54L8YFjup0zIGbZGQf02k03SWaEWUf22PNnTrKnHNFjd92xz/nMZptMDYRh5RI3s7jw8tI2++H3TbKbvGFDOVtvMcV+/uyJgb0Z7ca/mJm32XIDs6IfTpvRbf/4YHvm1eXgfUbXf6939AWmPwgV+nHpvE4768juUX2Nb2OFjTMAfgbDYGYsJkhTp061h+3bZz92yiS7dN64MfXCio1yMLnB5Bh/d8vNpthzjusOyij1ncOn9dpPzppor764y/7tkdFj8eqyNnvdR7uCsXzT1qOFf/NNp9izj+0OVsRy+VQrfkZ0A3x9NZi/cFOnfcubJo+Z4fH7pHewU483EAxT7DsYfMywrk6F+hGvU5IgTNttcsDYpdqFzdQ7dxldBla2Z77Zkfj8Tm8ZXT/8jJkpTT/Cjg1Gir5//CE9iXWFWhSfSI47uCdxNVg4e3ziijLryOJ9H9+IYsKJMvTv72sv2o4o4rN+EhZfM27UmBU7/U0vAOKaDSqQ5KrSAjG4m20ytrH3zx07i8Sx/MbOUTPrye/pKfnO+w/vSSUA4YbIVTfgC+eMXeaj+N197fbtbx0rbBiUov1xa8cYpsTsnCQ0IaDTR2f0UHiSmDnEp8+cOKaO73lXb7Byup6/6ZIuZ39gVnd5UiYBMzTe22Hbyc4VFUKQJACl+j7E7HOH2wb7fql+SA3J+6MnwCsrKQybMJeuD1UobRmfO2tipvegPqUVAODUyEwVxR479SV+A8t9XA0BoIalaZOrjm/bbrL900PuQXz6Gx3OGRO27VLfwurw5m3Gvgt1xPU83AV2dqgwwMPXlp60QqD/StURLguu70CF/L8SqiEmoK02nxKoreifqjB/IADiL9H7vxUVhsMGVwNxWJG2DAxgqNYcd3Bv1QUAurnreXRs0jdgZXG9A4tWmjYtu77T+f7HTx0+wInjyP16xzwLgVj1aLpZ7+L3uxktSQW96sKxqwaA1TXN92BlwfMQvGJ1xP5nW4dwAthrFPsGBBjPXXlButUiLbQU/wruCQ+q9p0qKejn3+oINrnxhmEvkGUpBb58/vCAHH1g9QUA5lfX8xi8JIF0rWpoa9plGLOsa0aHuhc/wMGs66pfmskgxINfdZcBM6Hr+ZceaA8mAFcb05hWYSXC85/5QGnmhInSVTf0BXjI9Q42uXgG9nxYsaopAMD6AbYDMwPiqEoKgRWk0s1UiN/e2x50/hH7VV8AMNO4nn/vQe5vffcKt+46bbdklckFtMVVDmbf6HPRzWQUWWY+MLSrDOD5b7v75QPHuPsRk1Gxb63px4o9JRivXy8qrZrACpVkgXrf9B5n+TCJw+L3469XUfWJQA+I9+AG2IWVFALpdDXqsnOHbbRZgQ1PmnezCgCsB67nFyWoM0nlYy+RpT3hJrHYrIzBhj7seg4uvlm+FzXBRgFTo+t5Nd+tpmHjjxUs6TtQA/EczM1p6wYzcXyDH+KR2L4DptYsG+WyIPn52ADPKbcA2G6TGnT7iKtqrZBFAO6Z41YNYMtOKh+bVdc7rsOhYvhiwt4DS39oq19xq5sJgbSm0xBxc22IM49Obuu03dzv3HdV8mYYqhmeyWqLT9ovYrYPvQKeH7HaweqD84DaCYC4EgJwR7kFQHdLGrisM1ctBAAMBpv31luOPUiBCpJ0Woi9i2tfA4Chs9QT7hFJfRRaQGD6THoGHo5Zvjd9mpuZZ+yfrFbe+im3fo6zBNfzUHlg4oWwwdUlS/1wTrB1kVUK5WEPiIkVRoRa8pCR4jacAj9QbgFJyydw75xxXgQAujROeXGWEJ/FYbKb97Gu4Ji9WNlgzKR2wQ8nSz2TmAv46Z3D9bilyDPFvB1dOObdvYmuEknvvLykzcmUYHLXoVO4qqUxz7oARnfVEWpg+DesFDVl/uHT4HvhBfpEuQUgFEU5K8D/fr89kO60cG2CkgQAOrDLvQI49uDeVJapP9yfLADxzWspwDclqaxfL2ovam4FoA5k+Z7LlAocsk/xzfvHEowEnz1rdHuxL8DBHPo5zSm6C9jzhOcHLsAzoNT5QJUEYIAZKX5ZbgHP3ZWsAt3xueTZIekUMglwA8iiAiXNMECaDXYxFSjr5h5+OUl1CU9pi6lAWQ9/slhaTARQtVzv4WwGDBs+98CIqfUTs4rb70sBGkJSm0Mnt9qDv4BIEH8stwB4aCY1opj5DgyG/QOW0L13Tp4JsOHE7B8dgDQCAD0yyayI1QGOeKXaFvflCQH1KksfYQZ1lYM7q1G3iaQ+yKoH77KDuz/T2OoPn+ZePeDyHT4TOjpi8quE+TBG70g4iS7mO1ZNaCVewgrwciWFQLd0NQLeemnex1LnUlng+VjJJhh6bZJw4fCrlEMVfMqzbAyTgOgErnLgWRo+A+tH3CEwzUrqmliSPGVdnp0mBjC6610IBv4Oj1esjHAtrwYDJnmMhnujmkOKv8IKtLaSQpJmODBf2jJczmalGC2NFQizVJLFAaa/Ysf3cOJzvYeNdTUmiLiTICYM13NwF077LTCOqwzo6/DjL/X+muBwyz0rwz07dCdBKJJqMGDSihP1KK2xAKxmlaZARcckbTrTnBACLqcsl96fVQBK6deYnZPMeJiVkzZqaS0zOJl1nZNAKOIm2KRDIkQ+SzsWSdak2ed0leWUODWCC0+aFKiFQLEDsmoIQNa7E+UCURBxF+CflRaEA6VKNjO1FAAA6kaSEGCTmnUVSGsJSrIAfe/L7hnUtQpAKJLcGNJYgKBalTL7mgigGromtPB3pVwkGkwA/lkVAYAPD/zB4w3BcprGccwlAKWcwLIIAPYDSZtD6LTFNsUuVwZs3kqpFHDecu1BwlAeSfshnH7G3/nIyaU33jAWxFcQ/AwHuazjedzBPYmn13BPbi4BqFIWeDCey58F1phSp4UuASjlcw+bvqvzkpgZloUkVQ3+5gi0msTICLcXf+dTjnvLUcAKFn8HM3Spo31c3onfqkO9x8S2ienucfMnmD/J/6cU7rtqXNUcHIthz7e7JyVXJIcaCYCpeBMc9w/HZWWXA5lLqmFGxU0m182paxNUEzAkbmMlXbU79J19wWzoErpLTnPrtwA2y/AAdR2U4Zu4qB+fYeG4FzfR4lmcFsefxaWQtBEwcEAWt5DgaqnLkoN9Bjxao8/iuiPaUu44rlvuNkxUyzUBkwCucSb5kWFlgA9UtfYaRTfBlZpBXQ5yYDTMqtFGwbnppMN7Ats+DlGg4kTvpUIIcIUPIUb++vDYWRKqFFSKpKuNLlMnnODiHV/s3CFcDZKc5MAAcV8bbAovOHFSYCHBRjGuau276+Sy1BAIEtw24qolBByWIQQIwCY+2odgqNOP6nbGycmKK2MrGJzVsvr9xIE7D7ifHb3+Wgzw2QIv1VAA/lrRQVgx4NofTnxxuwh+4/HGYZbHLIfBhP0Z7gfFyoPJEncPsiCeIAHA6lDqPVzeKFYX3HTDyoWgTPELJRBQLO249QUX36yXguLAaTH6B0LpOjjCyoUZExvzSkOwmAig62NlCXHnZZWbPtP0fRzRQ7haHYT9olYfiAKqAjbL6FjXyW4jA6sTIhxgs13rb0EtwGSBG1tJF94JIh0QKVpL/rj3ihAIygMkVxCA+71XhEBQ9YdW/B5YgW73XRECwfjBgoquRBIIppExfCWyskvxBIJpVOBSvFZihveKEAiq/gjColQaGItAMA2K9YptX5XQiASCaTD8JzRiNYLj5hm4cI7jdEI63BzLqNi0CIPjDgsAL3ivEAlALnBzywgAf4wyRBJsC2NDpkgt+Vk5qBCBYOsFLfnpG1SggbY9fVeIQDB1hB5o37UuaVIJBJMzjEmTOpIp8infFSMQTB2gFf+BI1O8uM53xQgEUw9IMXeMABglTvBesRoDN7mQRwvhDRHhGJfG8S8Cw+J3WSMxE0RjQopjxq4Aim3ivWJ1ABJNx8OnIKs97iS77iITRNOdAA8uYxuPEYDhfMHlR4puFOAyOcK3xCMOFIvXQxBNBP6ck/lbZR+AwK5IIhH+fNtnJgQX7nGJH5EQEHALmeiXXDcuyH8VzXOAcCxQl+Z8eGIQ+gQhBxEFI/w7Uh3hMjz+jqh4cy+aGMTrxF1oPIuL7QgPg8hwiJARhjlBtAV8B9Ey8B6iQeBCOMIn4mI/AmMhBAsiRSBcDC6px6PuIUQlTnKh0iESdBh/CGV84wsTghiuKCcaKeP+ueOC7JkQ/qx5DxoYVyULQEEcloMK1gxgIIQ9QUQHXCxHjHok+cPfoP787K7hlK8zD+0JQqAgsR4Ce+HvYDiEJAmzoSMESjRQLpgM0SDA7Ph5/qXDqha+A+EKs+kgVxfCoSP4VZgvGGXhm2HcIIQgR6Ar/B+X37FXQcgT5CZAHP/rPto1Kohs/42dQTwmPIuVDRH5kJkGf0PoFAgGhAxhSRBqBEKBmKmzRgJdLZ3XGayKVcvCnmMMDoh3JwqAXcI6tRLadyVrBUQcA+OA8b56UVeQqTGaiifMdwCGws8Ij4J3EPArns8Ws3mYeA5Mj/Ak0UyHyA2GiHfxyM1hXH3M5CgPqwpi+0QDh2GFikaeQ3gZxBsKA+pi5UB9MMsj7ApydYXpiiBsCL6LlQMzPAJchdEjoP6FwXZhDJhxQO9/BLrS8C2NAPA2eDxRAIb3AXyx74rWCgi6hRk+DF8CNQcqUPh3MDDi/MTDjSDYFAJiRX+HAE+h4xjUDsQ+igaOgnCcNqN71AqBIFfxOiGmTzTkIGZwrFJRVQVqWTTfAr43fd9hNQ6MDsGC2hYvGyEdUY9H53UGqwDKCFcohFrcesspQQAxCEYrhFhBAIiizD+sBvHTfFe0VgBDRsONYwaNxuoEYyFYV/w9qEJImBH+DCaKpi+CmgH1KC4g0fCOiFDtyjG87TZTAv0+/BkrDtSdaI4srCShSgOA+cNslWFSC1euA6waaDOY3RWT9I8PtgeqHdQfhEX3PT61xpDi7y8pAK8sYd1aitd8V7YW2HG7DXq3C3HVIwSC2kbz7CJrC3TpUG3A5jKahTFMH4skguHvoKZAd4+XjRwE0W9iIx5NnwS9HmVhk4ufkZgOWWDCDTRWsbhZF0mssadBWMao4EI9gu4PIbvxkxvqgrinWVM/NRrA0+DtkgIQrAKKP+i7wtUEDrjCxHlQC0JmigLMDJXAlTn+rsvGB2oJmAZWE8yqmKVh7UHsfiS3QEhEMDL+jhUBwWzDCHjYXOKcAVaieNmoV7hpRXxR5EVA4F/8HisNLEYIIxkKGyLQoR1Qi7Cpxcb+4H36glUKAWdhbQpDO+Jf1Av1hKqHUO+Y9XEWgvo8saAjyEIJy1ilOb8aIgZQWhos8JN9V7iaAMNH0666clCBWfG3pPCGUCO+/vkJgeUF1hqEEH/mmxuYBoyEiMyYsbEigEHDv2GjibKTokNjNl84e0IgKJjhof+HSTHA8PHQ7VhZsFEPzzJQLt7ByoTno89itgfzw9ITzUqDvcP8SycE5tdWOAAcGhAzUwsAvEONFGt8V7pRgJwEYcIMCMj2b55c1UC1BFEp1v7n/m9a0lLckoOK5x5gfJgxcUCGWfmI/XqLJgkniLpDS3FjJuYPBKDQvrPvijcKkD4UCaSh44d2dYLIDbRq34WVQ0bxZ31XnkAwFUBL/uOymD9YBRQ/x3cDCARTAXDfvWwBwLEx0sj4bgSBYMrDyjFXHzOvApLPzkFDCASbFVryz7JKae2jbHIzO8gRRFMCKVDX9bMpFQvA8Cog5vtuEIFgMkBLcQOrFg31s620Eq/7bhSBYFJg2JeNbcGqSThM8N0wAsGkgJbi2qoyfyAAK9im0Kt8N45AMEWA/ergcvYGVgtCQFHfDSQQTHHMYbWitU+wPiPFqhw0kkCwDqxc3c96WC0JicVy0FACwcYBzwVWa7KLmDCS/9x3YwkEE4XkPwVvsnrQoBKHeG8wgaAi0d6UOJDVk4wS3/bdcALBAFJ8g9WbcMzczMn1CKIxIMWq9Y+zjZgP0orP8t4BhJbGkOInMZ9kJF/quxMILQrJFzPfhFM3o8TfvHcGobUgxcsI6c/yQEg44L1DCC1l9TED4iiWJzJKLPDdMYTWgC4nykOtyS5jXUaJF313DqHZwZ9D3CqWR3p9gG2HIET+O4nQlJBizWuKbcvyTKYgjg50NN+dRWhGvf9Y1ghkpLjSd4cRmg6Xs0YhOCU1W4RpgvAGrfi9djbjrJEIGxUt+Y98dx6hsaElfxoGFtaIBB8NrcRvfHcioTGhpfhdza431ovWL2c7GiVe9d2ZhAZ0clNse9YMhOi8lG+AYNJjnVFte7BmoqFC275aisEcdC4hx9BKmKFC2/6sGQmJuCnAFsEUCWiF24asmQlX12glIBjHzI8JkrUCDam2dw3ref47niDygLVDsm0aayUysn13ijFEMFKsNrJtb9aKBBOpluL33geBYH1AK/HbpjF1lkvrFZuqFX/S92AQRJ2Znz/V8Idc1SKksdFK3O17UAiiPswv+X2Z8/Y2O8HZyShxBblSNy80xlaKLzacY1s9SUtxJJ0aNyXWNYw/v296vZ+9xSj+Qg4GjaCqAf5c7m9y5dKdWonrSSVqcEhxZ8O6M+eBtBTTKVdxA0KKl3MXuqRRCQGQjOKPeB9Ugk3H/HwxmThrQEMDYiYF5M01VuoCP803nzQ1BWmalFhAe4N8QUuxCIeavvmjZWiwIA6CdcH3wLc8JP9p3ZNTEA0TDlSw5JJa5AWvGMkvrltaIqJkWqNYr5FiLuUxrk8eXqPEnJpnYyQqLwoFBkdLMeSbUZoNWom/B3uvFWxT3+NMVIKMYltoJW6iFaEqjK+1FDeY5Wxz3+NKlJGwTENP1Ur8yTcjNSBWGiUuQy443+NIVBV3a342oozlgLFyDS35j7XkZ9klrNP3uBHVLlDXnMCKkQOGywnWBvr9QPuuvseHqE6ECxnIMIjLGQjH0XozvRhC0NmhAj8xtwkniOpDryxh3YOKn6olv7+ZQ7agbRD4wQI/edWTbJLvfifKIVnF2kbCtswxij/T6C4XuHgOt3IEnCK9nigzDS5jG8OtFxYRI3l/ntUlLcU/AqFV4no4DqLuvvuPqAktSohppBU/UytxDYTCSPEXDzP7nwOBVOIarfgZenn7bqib7/4halHCRjKIc1QQRxjJLzBKfNlI8bVgk634ClzxhDoSBAOTYnV0rxH8PwgQJVYNP8Ofxzt410hx23BZ/HyUvX6A7UCMzqpG/waalQgoJLHQJwAAAABJRU5ErkJggg==";

function pdfDate_(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(String(s || ""));
    if (!m) return escHtml_(s);
    let out = Number(m[3]) + " " + PDF_MONTHS_[Number(m[2]) - 1] + " " + m[1];
    if (m[4] !== undefined) {
        const h = Number(m[4]);
        out += ", " + (h % 12 || 12) + ":" + m[5] + (h < 12 ? " am" : " pm");
    }
    return out;
}

function pdfShop_(branchId) {
    const s = settingsMap_();
    const b = branchById_(bid_(branchId));
    return {
        name: s.business_name, tagline: s.tagline, email: s.email, gstin: s.gstin, state_name: s.state_name, state_code: s.state_code,
        footer: s.receipt_footer,
        address: (b && b.address) || s.address,
        phone: (b && b.phone) || s.phone,
        branch: activeBranches_().length > 1 && b ? b.name : "",
    };
}

/** Shared page frame: letterhead, title band, body, notes + signature. */
function pdfPage_(shop, title, stamp, body, notes) {
    const e = escHtml_;
    return (
        '<html><head><meta charset="utf-8"><style>' +
        // one sans face for the whole document — a serif heading over a sans table looked like two papers
        "body{font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#2b2520;margin:0}" +
        "table{border-collapse:collapse;width:100%}td,th{vertical-align:top}" +
        ".muted{color:#8a7f75}.small{font-size:10px}.b{font-weight:bold}.n{text-align:right;white-space:nowrap}" +
        ".sub{font-size:9px;color:#8a7f75}" +
        ".lbl{font-size:8.5px;letter-spacing:.6px;text-transform:uppercase;color:#8a7f75}" +
        // Google's HTML→PDF converter paints text, borders and images — never a background. So every
        // heading here is coloured text over a rule, and each fill is only a bonus where it does render
        // (the browser): all of them sit under dark text, which reads the same with or without them.
        ".items td,.items th{border:1px solid #e7ded2;padding:4px 6px;font-size:10px}" +
        ".items th{background:#f3ece2;color:#654321;border-bottom:2px solid #654321;font-size:8.5px;font-weight:bold;letter-spacing:.4px;text-transform:uppercase;text-align:left}" +
        ".items tbody tr{page-break-inside:avoid}.items td.mid{vertical-align:middle}" +
        ".box{background:#faf7f2}" +
        ".gst td,.gst th{border:1px solid #e7ded2;padding:4px 6px;font-size:10px;text-align:right}" +
        ".gst th{background:#f3ece2;font-size:8.5px;letter-spacing:.4px;text-transform:uppercase;color:#6b6157}" +
        ".tot td{border:1px solid #e7ded2;padding:4px 6px;font-size:10px}.tot td.v{text-align:right;white-space:nowrap}" +
        ".grand td{background:#f5bf03;color:#2b2520;border-top:2px solid #654321;border-bottom:2px solid #654321;font-size:11.5px;font-weight:bold;padding:6px}" +
        "</style></head><body>" +
        // letterhead
        '<table><tr>' +
        '<td style="width:52px;padding-right:10px"><img src="' + PDF_LOGO_ + '" width="52" height="52" alt=""></td>' +
        "<td>" +
        '<div style="font-size:20px;font-weight:bold;color:#654321">' + e(shop.name) + (shop.branch ? " · " + e(shop.branch) : "") + "</div>" +
        (shop.tagline ? '<div style="font-style:italic;color:#8a7f75">' + e(shop.tagline) + "</div>" : "") +
        '<div class="small" style="margin-top:3px">' + e(shop.address || "") + "</div>" +
        '<div class="small">' + e([shop.phone, shop.email].filter(Boolean).join(" · ")) + "</div>" +
        (shop.gstin ? '<div class="small b">GSTIN: ' + e(shop.gstin) + " · State: " + e(shop.state_name || "") + " (" + e(shop.state_code || "") + ")</div>" : "") +
        "</td></tr></table>" +
        '<div style="border-bottom:3px solid #f5bf03;margin:10px 0 12px"></div>' +
        // the document's name heads the page: brown bold text between two rules, which is the strongest
        // the PDF converter can render — a filled band would come out blank there
        '<table style="margin-bottom:12px"><tr><td style="border-top:2px solid #654321;border-bottom:2px solid #654321;color:#654321;font-size:13px;font-weight:bold;letter-spacing:3px;padding:7px;text-align:center">' + e(title) + "</td></tr></table>" +
        (stamp ? '<div style="color:#c62828;font-weight:bold;font-size:14px;text-align:center;margin:-6px 0 12px">' + e(stamp) + "</div>" : "") +
        body +
        // notes + signature
        '<table style="margin-top:18px"><tr>' +
        '<td class="small muted">' + (notes ? notes + "<br>" : "") + e(shop.footer || "") + "<br>This is a computer generated document." + "</td>" +
        '<td style="width:210px;text-align:center;padding-left:16px">' +
        '<div class="small" style="margin-bottom:34px">For ' + e(shop.name) + "</div>" +
        '<div style="border-top:1px solid #8a7f75;padding-top:4px" class="small muted">Authorised Signatory</div>' +
        "</td></tr></table>" +
        "</body></html>"
    );
}

/** Four label/value cells in a bordered strip. */
function pdfMeta_(cells) {
    const e = escHtml_;
    const cell = (c) => '<td  style="width:25%;padding:4px 6px;border:1px solid #e7ded2;font-size:10px"><div class="lbl">' + e(c[0]) + "</div>" + c[1] + "</td>";
    return '<table class="box">' + "<tr>" + cells.map(cell).join("") + "</tr></table>";
}

function invoicePdfHtml_(d) {
    const e = escHtml_;
    const sale = d.sale;
    const shop = pdfShop_(sale.branch_id);
    const showGst = !sale.gst_hidden;
    const name = (i) => i.product_name + (i.size && i.unit !== "ml" ? " " + i.size : "");
    const qty = (i) => (i.unit === "ml" ? r3_(i.qty) + " ml" : String(i.qty));
    const rates = {};
    d.items.forEach((i) => {
        const r = (rates[i.gst_rate] = rates[i.gst_rate] || { rate: i.gst_rate, taxable: 0, tax: 0 });
        r.taxable = r2_(r.taxable + i.taxable);
        r.tax = r2_(r.tax + i.tax);
    });
    const rows = d.items
        .map((i, n) => {
            const bg = n % 2 ? ' style="background:#faf7f2"' : "";
            return "<tr" + bg + '><td class="muted">' + (n + 1) + "</td><td><b>" + e(name(i)) + "</b>" +
                (i.brand ? '<div class="sub">' + e(i.brand) + "</div>" : "") + "</td>" +
                (showGst ? '<td class="small mid">' + e(i.hsn || "") + "</td>" : "") +
                '<td class="n mid">' + qty(i) + '</td><td class="n mid muted">' + inrText_(i.mrp) + '</td><td class="n mid">' + inrText_(i.price) + "</td>" +
                '<td class="n mid">' + (r2_(i.discount + (i.bill_disc_share || 0)) > 0 ? "-" + inrText_(r2_(i.discount + (i.bill_disc_share || 0))) : "—") + "</td>" +
                (showGst ? '<td class="n mid">' + i.gst_rate + '%</td><td class="n mid">' + Number(i.taxable).toFixed(2) + "</td>" : "") +
                '<td class="n mid b">' + inrText_(i.line_total) + "</td></tr>";
        })
        .join("");
    const head =
        '<tr><th style="width:22px">#</th><th>Item</th>' + (showGst ? '<th style="width:52px">HSN</th>' : "") +
        '<th class="n" style="width:38px">Qty</th><th class="n" style="width:54px">MRP</th><th class="n" style="width:54px">Rate</th>' +
        '<th class="n" style="width:50px">Disc</th>' +
        (showGst ? '<th class="n" style="width:38px">GST</th><th class="n" style="width:62px">Taxable</th>' : "") +
        '<th class="n" style="width:70px">Amount</th></tr>';

    const gstTable = showGst
        ? '<div class="lbl" style="margin-bottom:4px">GST summary (prices include GST)</div><table class="gst" style="width:auto">' +
          '<tr><th>Rate</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>Total tax</th></tr>' +
          Object.keys(rates).map((k) => rates[k]).sort((a, b) => a.rate - b.rate)
              .map((r) => "<tr><td>" + r.rate + "%</td><td>" + r.taxable.toFixed(2) + "</td><td>" + (r.tax / 2).toFixed(2) + "</td><td>" + (r.tax - r2_(r.tax / 2)).toFixed(2) + "</td><td>" + r.tax.toFixed(2) + "</td></tr>")
              .join("") + "</table>"
        : "";

    const line = (l, v, cls) => '<tr class="' + (cls || "") + '"><td>' + l + '</td><td class="v">' + v + "</td></tr>";
    const disc = r2_(sale.item_disc + sale.bill_disc);
    const pays = d.payments.filter((p) => p.amount > 0 && !p.return_id);
    const paid = r2_(pays.reduce((s, p) => s + p.amount, 0));
    const balance = r2_(sale.grand_total - paid);
    const saved = r2_(d.items.reduce((s, i) => s + (i.mrp || i.price) * i.qty, 0) - sale.grand_total);
    // one table, not three: separate tables size their own columns, which left Grand Total's divider
    // sitting at a different place from the CGST/SGST rows above it
    const totals =
        '<table class="tot">' + line("Items total", inrText_(sale.gross)) +
        (disc > 0 ? line("Discount", "-" + inrText_(disc)) : "") +
        (showGst ? line("Taxable value", inrText_(sale.taxable)) + line("CGST", inrText_(sale.cgst)) + line("SGST", inrText_(sale.sgst)) : "") +
        (sale.round_off ? line("Round off", inrText_(sale.round_off)) : "") +
        line("Grand Total", inrText_(sale.grand_total), "grand") +
        pays.map((p) => line("Paid · " + (METHOD_NAME_[p.method] || e(p.method)), inrText_(p.amount))).join("") +
        (balance > 0 ? line("<b>Balance due</b>", "<b>" + inrText_(balance) + "</b>") : balance < 0 ? line("Change given", inrText_(-balance)) : "") +
        (d.returns || []).map((r) => line("Credit note " + e(r.credit_note_no), "-" + inrText_(r.total))).join("") +
        "</table>" +
        (saved > 0 ? '<div style="margin-top:6px;text-align:right;color:#2e7d32;font-weight:bold">You saved ' + inrText_(saved) + " on MRP!</div>" : "");

    const body =
        pdfMeta_([
            ["Invoice No", "<b>" + e(sale.invoice_no) + "</b>"],
            ["Date", '<span style="white-space:nowrap">' + pdfDate_(sale.date) + "</span>"],
            ["Bill To", e(sale.customer_name || "Walk-in customer") + (sale.customer_phone ? "<br>" + e(sale.customer_phone) : "") + (sale.customer_gstin ? "<br>GSTIN: " + e(sale.customer_gstin) : "")],
            ["Served By", e(sale.salesman_name)],
        ]) +
        '<table class="items" style="margin-top:12px"><thead>' + head + "</thead><tbody>" + rows + "</tbody></table>" +
        '<table style="margin-top:14px"><tr><td style="padding-right:16px">' + gstTable + '</td><td style="width:265px">' + totals + "</td></tr></table>";
    return pdfPage_(shop, showGst && shop.gstin ? "TAX INVOICE" : "INVOICE", sale.status === "voided" ? "VOIDED" : "", body, "");
}

function creditNoteHtml_(r) {
    const e = escHtml_;
    const sale = findById_("Sales", r.sale_id) || {}; // the bill's own row, not the whole Sales sheet
    const saleItems = indexBy_(windowRows_("Sale_Items", "sale_id", r.sale_id, r.sale_id), "id");
    const items = windowRows_("Return_Items", "return_id", r.id, r.id);
    const rows2 = items
        .map((x, n) => {
            const si = saleItems[x.sale_item_id] || {};
            const nm = (si.product_name || "Item") + (si.size && si.unit !== "ml" ? " " + si.size : "");
            const bg = n % 2 ? ' style="background:#faf7f2"' : "";
            return "<tr" + bg + '><td class="muted">' + (n + 1) + "</td><td><b>" + e(nm) + '</b></td><td class="n">' + (si.unit === "ml" ? r3_(x.qty) + " ml" : x.qty) +
                '</td><td class="n">' + Number(x.taxable).toFixed(2) + '</td><td class="n">' + Number(x.tax).toFixed(2) + '</td><td class="n b">' + inrText_(x.amount) + "</td></tr>";
        })
        .join("");
    const line = (l, v, cls) => '<tr class="' + (cls || "") + '"><td>' + l + '</td><td class="v">' + v + "</td></tr>";
    const totals =
        '<table class="tot">' + line("Taxable value", inrText_(r.taxable)) + line("GST", inrText_(r.tax)) +
        line("Refund", inrText_(r.total), "grand") +
        line("Refunded by", e(METHOD_NAME_[r.refund_method] || r.refund_method || "")) + "</table>";
    const body =
        pdfMeta_([
            ["Credit Note No", "<b>" + e(r.credit_note_no) + "</b>"],
            ["Date", '<span style="white-space:nowrap">' + pdfDate_(r.at) + "</span>"],
            ["Against Invoice", e(r.invoice_no) + (sale.date ? "<br>" + pdfDate_(String(sale.date).slice(0, 10)) : "")],
            ["Customer", e(sale.customer_name || "Walk-in customer") + (sale.customer_phone ? "<br>" + e(sale.customer_phone) : "")],
        ]) +
        '<table class="items" style="margin-top:12px"><thead><tr><th style="width:22px">#</th><th>Item returned</th>' +
        '<th class="n" style="width:46px">Qty</th><th class="n" style="width:66px">Taxable</th>' +
        '<th class="n" style="width:58px">GST</th><th class="n" style="width:74px">Amount</th>' +
        "</tr></thead><tbody>" + rows2 + "</tbody></table>" +
        '<table style="margin-top:14px"><tr><td style="padding-right:16px">' + (r.reason ? '<div class="lbl">Reason</div><div class="small">' + e(r.reason) + "</div>" : "") +
        '</td><td style="width:265px">' + totals + "</td></tr></table>";
    return pdfPage_(pdfShop_(r.branch_id), "CREDIT NOTE", "", body, "");
}

/* ---------- saving ---------- */

// builds the PDF outside the lock (it takes a couple of seconds), then records it under a short lock
// `pre`: the bill's lines, payments and returns when the caller already has them (the night run)
function savePdfForSale_(s, pre) {
    const voided = s.status === "voided";
    const url = makePdf_(invoicePdfHtml_(saleDetail_(s, null, pre)), pdfName_(s.invoice_no, voided), invoiceFolder_(s.date, isTaxInvoice_(s)));
    const stored = url + (voided ? PDF_VOID_MARK_ : "");
    return withLock_(() => {
        // every checkout waits on this lock: look at the bill's own row, not the whole sheet
        const fresh = rowIfId_("Sales", s._r, s.id) || findBy_("Sales", "id", s.id);
        if (!fresh) return { pdf_url: "" };
        if (fresh.pdf_url) {
            trashPdf_(url); // someone else saved it meanwhile — keep one file
            return { pdf_url: fresh.pdf_url, already: true };
        }
        fresh.pdf_url = stored;
        setCell_("Sales", fresh, "pdf_url");
        return { pdf_url: stored };
    });
}

function savePdfForReturn_(r) {
    // a credit note is filed with the bill it belongs to
    const sale = findById_("Sales", r.sale_id);
    const gst = sale ? isTaxInvoice_(sale) : !!str_(setting_("gstin"));
    const url = makePdf_(creditNoteHtml_(r), pdfName_(r.credit_note_no, false), invoiceFolder_(r.at, gst));
    withLock_(() => {
        const fresh = rowIfId_("Returns", r._r, r.id) || findBy_("Returns", "id", r.id);
        if (!fresh) return;
        if (fresh.pdf_url) return trashPdf_(url);
        fresh.pdf_url = url;
        setCell_("Returns", fresh, "pdf_url");
    });
}

function apiSaveInvoicePdf_(p, ctx) {
    const s = findById_("Sales", p.id);
    if (!s) fail_("Bill not found");
    if (!canSeeSale_(ctx, s)) fail_("You can't open this bill", "FORBIDDEN");
    if (s.pdf_url) return { message: "PDF already saved in Drive", data: { pdf_url: s.pdf_url, already: true } };
    const r = savePdfForSale_(s);
    log_(ctx, "PDF", "Sales", s.id, s.invoice_no);
    return { message: r.already ? "PDF already saved in Drive" : "PDF saved to Drive", data: r };
}

const PDF_RESUME_FN_ = "resumeInvoicePdfs";
const PDF_HOUR_ = 2; // the night run, while the shop is closed
const PDF_TAIL_ = 3000; // recent rows of Sale_Items / Payments read once per run — a day's bills sit well inside
const PDF_SCHEDULE_ = "nightly-2"; // which timer is installed; an older sheet still on the 15-minute one switches itself

/**
 * A bill's lines, payments and returns for its PDF — or null while the bill isn't fully written yet
 * (checkout writes the bill row first, then its lines and payments): it is then left for the next run
 * instead of becoming a PDF with lines missing.
 *
 * Lines and payments come from the recent rows read once per run. Both tables are written in bill
 * order, so a recent bill's rows are all there; a bill at the very start of that block or older, or one
 * whose lines don't add up to its item count, is read the old way (the whole column), as before.
 */
function pdfBillParts_(s, recent) {
    const from = (rows) => (rows.length && rows[0].sale_id < s.id ? rows.filter((r) => r.sale_id === s.id) : null);
    const count = (list) => r3_(list.reduce((a, l) => a + (l.unit === "pcs" ? num_(l.qty) : 1), 0));
    let items = from(recent.items);
    if (!items || !items.length || count(items) !== r3_(num_(s.items))) items = windowRows_("Sale_Items", "sale_id", s.id, s.id);
    // what was paid (cash net of change, plus any exchange credit) is the bill total — the rows the PDF
    // prints; a void's refund rows are negative and a return's carry its id
    const paid = (list) => r2_(list.filter((p) => num_(p.amount) > 0 && !p.return_id).reduce((a, p) => a + num_(p.amount), 0));
    let pays = from(recent.payments);
    if (!pays || paid(pays) !== r2_(num_(s.grand_total))) pays = windowRows_("Payments", "sale_id", s.id, s.id);
    // every bill has a line; a bill with something to pay has a payment
    if (!items.length || (num_(s.grand_total) > 0 && !(paid(pays) > 0))) return null;
    // credit notes: those tables are small and a return can come any time after the bill, so the run
    // holds them whole; the same rows saleDetail_ would pick (its lines by return id range)
    const rets = recent.returns ? recent.returns.filter((r) => r.sale_id === s.id) : windowRows_("Returns", "sale_id", s.id, s.id);
    const retItems = !rets.length ? []
        : recent.retItems ? recent.retItems.filter((ri) => ri.return_id >= rets[0].id && ri.return_id <= rets[rets.length - 1].id)
        : windowRows_("Return_Items", "return_id", rets[0].id, rets[rets.length - 1].id);
    return { items: items, payments: pays, returns: rets, retItems: retItems };
}

/** One-off follow-up when a night's PDFs don't fit in one run (Apps Script stops a run at 6 minutes). */
function resumeInvoicePdfs() {
    clearPdfResume_();
    savePendingInvoicePdfs();
}

function schedulePdfResume_() {
    try {
        clearPdfResume_();
        ScriptApp.newTrigger(PDF_RESUME_FN_).timeBased().after(60 * 1000).create();
    } catch (e) {
        console.error("schedulePdfResume_", e);
    }
}

function clearPdfResume_() {
    try {
        ScriptApp.getProjectTriggers()
            .filter((t) => t.getHandlerFunction() === PDF_RESUME_FN_)
            .forEach((t) => ScriptApp.deleteTrigger(t));
    } catch (e) {
        console.error("clearPdfResume_", e);
    }
}

/**
 * Night timer (2 am, then follow-ups until done): PDFs for the bills and credit notes that have none,
 * and -VOID names for voided bills. Checkout never waits for this.
 *
 * It finds that work from three columns (id, pdf_url, status) instead of reading every bill, and reads
 * each pending bill's own row — the cost stays small however many bills the shop has.
 */
function savePendingInvoicePdfs() {
    resetReqCache_();
    PDF_DIRS_ = {}; // look the folders up again: someone may have moved or renamed them since
    migrateRoleNames_(); // one-time, and cheap once done: the app works either way meanwhile
    try {
        ensureBackupTrigger_(); // puts the monthly backup in place without anyone running Setup
    } catch (e) {
        console.error("ensureBackupTrigger_", e);
    }
    try {
        ensureMaintenanceTrigger_(); // and the nightly spare-rows top-up (maintenance.gs)
    } catch (e) {
        console.error("ensureMaintenanceTrigger_", e);
    }
    if (setting_("invoice_pdfs") === "no") return;
    // a sheet set up before the night run still has the 15-minute timer: swap it once
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty("pdf_schedule") !== PDF_SCHEDULE_) {
        try {
            syncPdfTrigger_();
        } catch (e) {
            console.error("syncPdfTrigger_", e);
        }
    }
    const started = Date.now();
    const inTime = () => Date.now() - started < 4 * 60 * 1000; // Apps Script stops at 6 min; a follow-up run continues
    let done = 0;
    let unfinished = false;
    try {
        done += migratePdfFolders_(inTime); // one-time move from the old yyyy-MM folders
    } catch (e) {
        console.error("migratePdfFolders_: " + e);
    }
    const sales = pendingPdfRows_("Sales", true);
    const returns = pendingPdfRows_("Returns", false);
    // a bill's lines and payments: the recent rows, read once for the whole run
    const recent = sales.some((p) => !p.url)
        ? {
            items: tailRows_("Sale_Items", PDF_TAIL_), payments: tailRows_("Payments", PDF_TAIL_),
            returns: rows_("Returns").slice(), retItems: rows_("Return_Items").slice(),
        }
        : { items: [], payments: [] };
    for (let i = 0; i < sales.length; i++) {
        if (!inTime()) {
            unfinished = true;
            break;
        }
        let s = null;
        try {
            s = rowIfId_("Sales", sales[i].r, sales[i].id) || findById_("Sales", sales[i].id);
            if (!s) continue;
            if (!s.pdf_url) {
                const parts = pdfBillParts_(s, recent);
                if (!parts) {
                    console.warn("PDF for " + s.invoice_no + ": bill not fully saved yet — next run");
                    continue;
                }
                savePdfForSale_(s, parts);
                done++;
            } else if (s.status === "voided" && s.pdf_url.slice(-PDF_VOID_MARK_.length) !== PDF_VOID_MARK_) {
                DriveApp.getFileById(pdfFileId_(s.pdf_url)).setName(pdfName_(s.invoice_no, true));
                withLock_(() => {
                    const fresh = rowIfId_("Sales", s._r, s.id) || findBy_("Sales", "id", s.id);
                    if (fresh && fresh.pdf_url && fresh.pdf_url.slice(-PDF_VOID_MARK_.length) !== PDF_VOID_MARK_) {
                        fresh.pdf_url += PDF_VOID_MARK_;
                        setCell_("Sales", fresh, "pdf_url");
                    }
                });
                done++;
            }
        } catch (e) {
            console.error("PDF for " + (s ? s.invoice_no : "bill " + sales[i].id) + ": " + e); // retried on the next run
        }
    }
    for (let i = 0; i < returns.length; i++) {
        if (!inTime()) {
            unfinished = true;
            break;
        }
        let r = null;
        try {
            r = rowIfId_("Returns", returns[i].r, returns[i].id) || findById_("Returns", returns[i].id);
            if (!r || r.pdf_url) continue;
            // the credit note's lines are written after its row: not there yet → next run
            if (!windowRows_("Return_Items", "return_id", r.id, r.id).length) {
                console.warn("PDF for " + r.credit_note_no + ": credit note not fully saved yet — next run");
                continue;
            }
            savePdfForReturn_(r);
            done++;
        } catch (e) {
            console.error("PDF for " + (r ? r.credit_note_no : "credit note " + returns[i].id) + ": " + e);
        }
    }
    if (unfinished) schedulePdfResume_(); // more than one run's worth tonight: carry on in a minute
    return done;
}

/**
 * Which rows need PDF work, from the id / pdf_url (/ status) columns only: {id, r (sheet row), url},
 * oldest first. Sales: no PDF yet, or voided with the PDF not yet renamed. Returns: no PDF yet.
 */
function pendingPdfRows_(name, withVoids) {
    const ids = columnValues_(name, "id");
    const urls = columnValues_(name, "pdf_url");
    const status = withVoids ? columnValues_(name, "status") : [];
    const n = Math.min(ids.length, urls.length, withVoids ? status.length : urls.length); // a row added between reads waits for the next run
    const out = [];
    for (let i = 0; i < n; i++) {
        const id = num_(ids[i]);
        if (!id) continue; // an emptied row
        const url = str_(urls[i]);
        const renameVoid = withVoids && url && status[i] === "voided" && url.slice(-PDF_VOID_MARK_.length) !== PDF_VOID_MARK_;
        if (!url || renameVoid) out.push({ id: id, r: i + 2, url: url });
    }
    return out.sort((a, b) => a.id - b.id);
}

function syncPdfTrigger_() {
    ScriptApp.getProjectTriggers()
        .filter((t) => t.getHandlerFunction() === PDF_FN_)
        .forEach((t) => ScriptApp.deleteTrigger(t));
    const props = PropertiesService.getScriptProperties();
    if (setting_("invoice_pdfs") === "no") {
        clearPdfResume_();
        props.deleteProperty("pdf_schedule");
        return false;
    }
    ScriptApp.newTrigger(PDF_FN_).timeBased().everyDays(1).atHour(PDF_HOUR_).inTimezone(APP.TZ).create();
    props.setProperty("pdf_schedule", PDF_SCHEDULE_);
    return true;
}
